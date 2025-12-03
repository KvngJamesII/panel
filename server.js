const express = require('express');
const multer = require('multer');
const { exec, spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const BOTS_DIR = './bots';
const PROJECT_ID = process.env.GCLOUD_PROJECT_ID || 'elitehost-480108';
const REGION = process.env.GCLOUD_REGION || 'us-central1';

const deploymentStatus = {};

(async () => {
  try {
    await fs.mkdir(BOTS_DIR, { recursive: true });
    await fs.mkdir('./uploads', { recursive: true });
  } catch (err) {
    console.error('Failed to create directories:', err);
  }
})();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

function emitLog(botName, message, type = 'info') {
  const logEntry = {
    botName,
    message,
    type,
    timestamp: new Date().toISOString()
  };
  io.emit('log', logEntry);
}

function emitStatus(botName, status, progress = null) {
  deploymentStatus[botName] = { status, progress, timestamp: Date.now() };
  io.emit('deploymentStatus', { botName, status, progress });
}

app.get('/api/deployment-status', (req, res) => {
  res.json(deploymentStatus);
});

app.post('/api/bots', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Bot name is required' });
    }

    const botName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    const botDir = path.join(BOTS_DIR, botName);

    await fs.mkdir(botDir, { recursive: true });

    const indexJs = `// ${botName} Telegram Bot
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

bot.onText(/\\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Welcome to ${botName}! 🤖');
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text.startsWith('/')) {
    bot.sendMessage(chatId, \`You said: \${msg.text}\`);
  }
});

console.log('Bot is running...');
`;

    const packageJson = {
      name: botName,
      version: '1.0.0',
      main: 'index.js',
      scripts: {
        start: 'node index.js'
      },
      dependencies: {
        'node-telegram-bot-api': '^0.61.0'
      }
    };

    const dockerfile = `FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "start"]`;

    await fs.writeFile(path.join(botDir, 'index.js'), indexJs);
    await fs.writeFile(path.join(botDir, 'package.json'), JSON.stringify(packageJson, null, 2));
    await fs.writeFile(path.join(botDir, 'Dockerfile'), dockerfile);

    res.json({ success: true, botName, message: 'Bot project created' });
  } catch (err) {
    console.error('Create bot error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bots/:botName/files', async (req, res) => {
  try {
    const { botName } = req.params;
    const botDir = path.join(BOTS_DIR, botName);
    
    async function readDir(dir, relativePath = '') {
      const items = [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const itemPath = path.join(relativePath, entry.name);
        
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          items.push({
            name: entry.name,
            path: itemPath,
            type: 'folder',
            children: await readDir(fullPath, itemPath)
          });
        } else {
          const stats = await fs.stat(fullPath);
          items.push({
            name: entry.name,
            path: itemPath,
            type: 'file',
            size: stats.size,
            modified: stats.mtime
          });
        }
      }
      
      return items.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'folder' ? -1 : 1;
      });
    }
    
    const files = await readDir(botDir);
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bots/:botName/file', async (req, res) => {
  try {
    const { botName } = req.params;
    const { filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fullPath = path.join(BOTS_DIR, botName, filePath);
    const content = await fs.readFile(fullPath, 'utf8');
    
    res.json({ success: true, content, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/bots/:botName/file', async (req, res) => {
  try {
    const { botName } = req.params;
    const { filePath, content } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fullPath = path.join(BOTS_DIR, botName, filePath);
    await fs.writeFile(fullPath, content || '');
    
    res.json({ success: true, message: 'File saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bots/:botName/file', async (req, res) => {
  try {
    const { botName } = req.params;
    const { filePath, type } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fullPath = path.join(BOTS_DIR, botName, filePath);
    
    if (type === 'folder') {
      await fs.mkdir(fullPath, { recursive: true });
    } else {
      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fullPath, '');
    }
    
    res.json({ success: true, message: `${type === 'folder' ? 'Folder' : 'File'} created` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bots/:botName/file', async (req, res) => {
  try {
    const { botName } = req.params;
    const { filePath } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fullPath = path.join(BOTS_DIR, botName, filePath);
    const stats = await fs.stat(fullPath);
    
    if (stats.isDirectory()) {
      await fs.rm(fullPath, { recursive: true });
    } else {
      await fs.unlink(fullPath);
    }
    
    res.json({ success: true, message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bots/:botName/rename', async (req, res) => {
  try {
    const { botName } = req.params;
    const { oldPath, newPath } = req.body;
    
    const oldFullPath = path.join(BOTS_DIR, botName, oldPath);
    const newFullPath = path.join(BOTS_DIR, botName, newPath);
    
    await fs.rename(oldFullPath, newFullPath);
    
    res.json({ success: true, message: 'Renamed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', upload.single('botFile'), async (req, res) => {
  try {
    const { file } = req;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const botName = path.basename(file.originalname, path.extname(file.originalname));
    const botDir = path.join(BOTS_DIR, botName);

    await fs.mkdir(botDir, { recursive: true });

    const content = await fs.readFile(file.path, 'utf8');
    await fs.writeFile(path.join(botDir, 'index.js'), content);
    await fs.unlink(file.path);

    const packageJson = {
      name: botName,
      version: '1.0.0',
      main: 'index.js',
      scripts: {
        start: 'node index.js'
      },
      dependencies: {
        'node-telegram-bot-api': '^0.61.0'
      }
    };

    await fs.writeFile(
      path.join(botDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    const dockerfile = `FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "start"]`;

    await fs.writeFile(path.join(botDir, 'Dockerfile'), dockerfile);

    res.json({ 
      success: true, 
      botName,
      message: 'Bot uploaded successfully'
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bots/:botName/config', async (req, res) => {
  try {
    const { botName } = req.params;
    const botDir = path.join(BOTS_DIR, botName);
    
    let packageJson = {};
    let dockerfile = '';
    
    try {
      const pkgContent = await fs.readFile(path.join(botDir, 'package.json'), 'utf8');
      packageJson = JSON.parse(pkgContent);
    } catch {}
    
    try {
      dockerfile = await fs.readFile(path.join(botDir, 'Dockerfile'), 'utf8');
    } catch {}
    
    res.json({
      success: true,
      config: {
        startCommand: packageJson.scripts?.start || 'node index.js',
        dependencies: packageJson.dependencies || {},
        dockerfile
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/bots/:botName/config', async (req, res) => {
  try {
    const { botName } = req.params;
    const { startCommand, dependencies, dockerfile } = req.body;
    const botDir = path.join(BOTS_DIR, botName);
    
    const pkgPath = path.join(botDir, 'package.json');
    let packageJson = {};
    
    try {
      const content = await fs.readFile(pkgPath, 'utf8');
      packageJson = JSON.parse(content);
    } catch {}
    
    if (startCommand) {
      packageJson.scripts = packageJson.scripts || {};
      packageJson.scripts.start = startCommand;
    }
    
    if (dependencies) {
      packageJson.dependencies = dependencies;
    }
    
    await fs.writeFile(pkgPath, JSON.stringify(packageJson, null, 2));
    
    if (dockerfile) {
      await fs.writeFile(path.join(botDir, 'Dockerfile'), dockerfile);
    }
    
    res.json({ success: true, message: 'Configuration saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deploy/:botName', async (req, res) => {
  const { botName } = req.params;
  const botDir = path.join(BOTS_DIR, botName);

  try {
    await fs.access(botDir);
    
    const serviceName = `${botName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    
    emitStatus(botName, 'deploying', 0);
    emitLog(botName, '🚀 Starting deployment to Google Cloud Run...', 'info');
    
    res.json({ success: true, message: 'Deployment started', serviceName });
    
    emitLog(botName, '📦 Building container image...', 'info');
    emitStatus(botName, 'deploying', 20);
    
    const buildCmd = `gcloud builds submit --tag gcr.io/${PROJECT_ID}/${serviceName} ${botDir}`;
    
    try {
      await execWithLogs(buildCmd, botName);
      emitLog(botName, '✅ Container built successfully', 'success');
      emitStatus(botName, 'deploying', 60);
    } catch (buildError) {
      emitLog(botName, `❌ Build failed: ${buildError.message}`, 'error');
      emitStatus(botName, 'failed', 0);
      return;
    }
    
    emitLog(botName, '🌐 Deploying to Cloud Run...', 'info');
    
    const deployCmd = `gcloud run deploy ${serviceName} \
      --image gcr.io/${PROJECT_ID}/${serviceName} \
      --platform managed \
      --region ${REGION} \
      --allow-unauthenticated \
      --min-instances 0 \
      --max-instances 1 \
      --memory 256Mi \
      --cpu 1`;
    
    try {
      await execWithLogs(deployCmd, botName);
      emitLog(botName, '✅ Bot deployed successfully to Cloud Run!', 'success');
      emitStatus(botName, 'running', 100);
    } catch (deployError) {
      emitLog(botName, `❌ Deployment failed: ${deployError.message}`, 'error');
      emitStatus(botName, 'failed', 0);
    }
    
  } catch (err) {
    console.error('Deploy error:', err);
    emitLog(botName, `❌ Error: ${err.message}`, 'error');
    emitStatus(botName, 'failed', 0);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.post('/api/restart/:botName', async (req, res) => {
  const { botName } = req.params;
  const serviceName = `${botName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    emitStatus(botName, 'restarting', 0);
    emitLog(botName, '🔄 Restarting bot...', 'info');
    
    const cmd = `gcloud run services update ${serviceName} \
      --region ${REGION} \
      --min-instances 1`;
    
    await execWithLogs(cmd, botName);
    
    emitLog(botName, '✅ Bot restarted successfully', 'success');
    emitStatus(botName, 'running', 100);
    
    res.json({ success: true, message: 'Bot restarted' });
  } catch (err) {
    emitLog(botName, `❌ Restart failed: ${err.message}`, 'error');
    emitStatus(botName, 'failed', 0);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stop/:botName', async (req, res) => {
  const { botName } = req.params;
  const serviceName = `${botName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    emitStatus(botName, 'stopping', 0);
    emitLog(botName, '⏸️ Stopping bot...', 'info');
    
    const cmd = `gcloud run services update ${serviceName} \
      --region ${REGION} \
      --min-instances 0 \
      --max-instances 0`;

    await execWithLogs(cmd, botName);

    emitLog(botName, '✅ Bot stopped (scaled to 0)', 'success');
    emitStatus(botName, 'stopped', 0);

    res.json({ 
      success: true, 
      message: 'Bot stopped (scaled to 0)'
    });
  } catch (err) {
    emitLog(botName, `❌ Stop failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/delete/:botName', async (req, res) => {
  const { botName } = req.params;
  const serviceName = `${botName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const botDir = path.join(BOTS_DIR, botName);

  try {
    emitLog(botName, '🗑️ Deleting bot...', 'info');
    
    const cmd = `gcloud run services delete ${serviceName} --region ${REGION} --quiet`;
    await execPromise(cmd).catch(() => {});

    await fs.rm(botDir, { recursive: true, force: true });

    emitLog(botName, '✅ Bot deleted from Cloud Run and local storage', 'success');
    delete deploymentStatus[botName];

    res.json({ 
      success: true, 
      message: 'Bot deleted from Cloud Run and local storage'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs/:botName', async (req, res) => {
  const { botName } = req.params;
  const serviceName = `${botName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    const cmd = `gcloud run services logs read ${serviceName} --region ${REGION} --limit 100`;
    const logs = await execPromise(cmd);

    res.json({ 
      success: true, 
      logs: logs.split('\n').filter(line => line.trim())
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bots', async (req, res) => {
  try {
    const files = await fs.readdir(BOTS_DIR);
    const bots = [];

    for (const file of files) {
      const botDir = path.join(BOTS_DIR, file);
      const stats = await fs.stat(botDir);

      if (stats.isDirectory()) {
        const serviceName = `${file}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

        let status = deploymentStatus[file]?.status || 'unknown';
        
        if (status === 'unknown') {
          try {
            const cmd = `gcloud run services describe ${serviceName} --region ${REGION} --format="value(status.conditions[0].status)"`;
            const result = await execPromise(cmd);
            status = result.includes('True') ? 'running' : 'stopped';
          } catch {
            status = 'not-deployed';
          }
        }

        bots.push({
          name: file,
          status,
          serviceName,
          progress: deploymentStatus[file]?.progress || 0
        });
      }
    }

    res.json({ bots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function execWithLogs(cmd, botName) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { maxBuffer: 1024 * 1024 * 10 });
    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      output += data;
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => emitLog(botName, line, 'output'));
    });

    child.stderr.on('data', (data) => {
      errorOutput += data;
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        const type = line.toLowerCase().includes('error') ? 'error' : 'output';
        emitLog(botName, line, type);
      });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const error = new Error(`Command failed with code ${code}`);
        error.logs = [output, errorOutput].filter(Boolean);
        reject(error);
      } else {
        resolve(output);
      }
    });
  });
}

function execPromise(cmd, onData) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { maxBuffer: 1024 * 1024 * 10 });
    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      output += data;
      if (onData) onData(data.toString());
    });

    child.stderr.on('data', (data) => {
      errorOutput += data;
      if (onData) onData(data.toString());
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const error = new Error(`Command failed with code ${code}`);
        error.logs = [output, errorOutput].filter(Boolean);
        reject(error);
      } else {
        resolve(output);
      }
    });
  });
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Bot Manager Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
});
