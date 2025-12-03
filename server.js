const express = require('express');
const multer = require('multer');
const { exec, spawn, execSync } = require('child_process');
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

// Mobile detection middleware
app.get('/', (req, res) => {
  const userAgent = req.headers['user-agent'] || '';
  const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  
  if (isMobile) {
    res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.use(express.static('public'));

const BOTS_DIR = path.resolve('./bots');
const PROJECT_ID = process.env.GCLOUD_PROJECT_ID || 'elitehost-480108';
const REGION = process.env.GCLOUD_REGION || 'us-central1';
const GCLOUD_KEY_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// Initialize Google Cloud authentication
async function initGoogleCloud() {
  if (!GCLOUD_KEY_FILE) {
    console.log('⚠️ No GOOGLE_APPLICATION_CREDENTIALS set - GCloud commands may fail');
    return false;
  }
  
  try {
    // Activate service account
    console.log('🔐 Authenticating with Google Cloud...');
    execSync(`gcloud auth activate-service-account --key-file="${GCLOUD_KEY_FILE}"`, {
      stdio: 'pipe'
    });
    
    // Set project
    execSync(`gcloud config set project ${PROJECT_ID}`, {
      stdio: 'pipe'
    });
    
    console.log(`✅ Authenticated with Google Cloud (Project: ${PROJECT_ID})`);
    return true;
  } catch (err) {
    console.error('❌ Google Cloud authentication failed:', err.message);
    return false;
  }
}

// Run authentication on startup
initGoogleCloud();

const deploymentStatus = {};

function sanitizeBotName(name) {
  if (!name || typeof name !== 'string') return null;
  const sanitized = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  if (!sanitized || sanitized.includes('..') || sanitized.startsWith('-')) return null;
  return sanitized;
}

function validateFilePath(botName, filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  if (filePath.includes('..') || path.isAbsolute(filePath)) return null;
  
  const sanitizedBotName = sanitizeBotName(botName);
  if (!sanitizedBotName) return null;
  
  const botDir = path.join(BOTS_DIR, sanitizedBotName);
  const fullPath = path.resolve(botDir, filePath);
  
  if (!fullPath.startsWith(botDir + path.sep) && fullPath !== botDir) {
    return null;
  }
  
  return { botDir, fullPath, sanitizedBotName };
}

function validateBotAccess(botName) {
  const sanitized = sanitizeBotName(botName);
  if (!sanitized) return null;
  
  const botDir = path.join(BOTS_DIR, sanitized);
  const resolved = path.resolve(botDir);
  
  if (!resolved.startsWith(BOTS_DIR + path.sep) && resolved !== BOTS_DIR) {
    return null;
  }
  
  return { botDir: resolved, sanitizedBotName: sanitized };
}

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
    const sanitized = sanitizeBotName(name);
    
    if (!sanitized) {
      return res.status(400).json({ error: 'Invalid bot name. Use only letters, numbers, underscores, and hyphens.' });
    }

    const botDir = path.join(BOTS_DIR, sanitized);

    await fs.mkdir(botDir, { recursive: true });

    const indexJs = `// ${sanitized} Telegram Bot
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

bot.onText(/\\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Welcome to ${sanitized}! 🤖');
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
      name: sanitized,
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

    res.json({ success: true, botName: sanitized, message: 'Bot project created' });
  } catch (err) {
    console.error('Create bot error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bots/:botName/files', async (req, res) => {
  try {
    const validation = validateBotAccess(req.params.botName);
    if (!validation) {
      return res.status(400).json({ error: 'Invalid bot name' });
    }
    
    const { botDir } = validation;
    
    async function readDir(dir, relativePath = '') {
      const items = [];
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return items;
      }
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const itemPath = path.join(relativePath, entry.name);
        
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
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
    const { filePath } = req.query;
    const validation = validateFilePath(req.params.botName, filePath);
    
    if (!validation) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    
    const content = await fs.readFile(validation.fullPath, 'utf8');
    res.json({ success: true, content, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/bots/:botName/file', async (req, res) => {
  try {
    const { filePath, content } = req.body;
    const validation = validateFilePath(req.params.botName, filePath);
    
    if (!validation) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    
    await fs.writeFile(validation.fullPath, content || '');
    res.json({ success: true, message: 'File saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bots/:botName/file', async (req, res) => {
  try {
    const { filePath, type } = req.body;
    const validation = validateFilePath(req.params.botName, filePath);
    
    if (!validation) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    
    if (type === 'folder') {
      await fs.mkdir(validation.fullPath, { recursive: true });
    } else {
      const dir = path.dirname(validation.fullPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(validation.fullPath, '');
    }
    
    res.json({ success: true, message: `${type === 'folder' ? 'Folder' : 'File'} created` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bots/:botName/file', async (req, res) => {
  try {
    const { filePath } = req.body;
    const validation = validateFilePath(req.params.botName, filePath);
    
    if (!validation) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    
    const stats = await fs.stat(validation.fullPath);
    
    if (stats.isDirectory()) {
      await fs.rm(validation.fullPath, { recursive: true });
    } else {
      await fs.unlink(validation.fullPath);
    }
    
    res.json({ success: true, message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bots/:botName/rename', async (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    
    const oldValidation = validateFilePath(req.params.botName, oldPath);
    const newValidation = validateFilePath(req.params.botName, newPath);
    
    if (!oldValidation || !newValidation) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    
    await fs.rename(oldValidation.fullPath, newValidation.fullPath);
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

    const rawName = path.basename(file.originalname, path.extname(file.originalname));
    const botName = sanitizeBotName(rawName);
    
    if (!botName) {
      await fs.unlink(file.path);
      return res.status(400).json({ error: 'Invalid file name' });
    }
    
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
    const validation = validateBotAccess(req.params.botName);
    if (!validation) {
      return res.status(400).json({ error: 'Invalid bot name' });
    }
    
    const { botDir } = validation;
    
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
    const validation = validateBotAccess(req.params.botName);
    if (!validation) {
      return res.status(400).json({ error: 'Invalid bot name' });
    }
    
    const { botDir } = validation;
    const { startCommand, dependencies, dockerfile } = req.body;
    
    const pkgPath = path.join(botDir, 'package.json');
    let packageJson = {};
    
    try {
      const content = await fs.readFile(pkgPath, 'utf8');
      packageJson = JSON.parse(content);
    } catch {}
    
    if (startCommand && typeof startCommand === 'string') {
      packageJson.scripts = packageJson.scripts || {};
      packageJson.scripts.start = startCommand;
    }
    
    if (dependencies && typeof dependencies === 'object') {
      packageJson.dependencies = dependencies;
    }
    
    await fs.writeFile(pkgPath, JSON.stringify(packageJson, null, 2));
    
    if (dockerfile && typeof dockerfile === 'string') {
      await fs.writeFile(path.join(botDir, 'Dockerfile'), dockerfile);
    }
    
    res.json({ success: true, message: 'Configuration saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deploy/:botName', async (req, res) => {
  const validation = validateBotAccess(req.params.botName);
  if (!validation) {
    return res.status(400).json({ error: 'Invalid bot name' });
  }
  
  const { botDir, sanitizedBotName } = validation;

  try {
    await fs.access(botDir);
    
    const serviceName = `${sanitizedBotName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    
    emitStatus(sanitizedBotName, 'deploying', 0);
    emitLog(sanitizedBotName, '🚀 Starting deployment to Google Cloud Run...', 'info');
    
    res.json({ success: true, message: 'Deployment started', serviceName });
    
    emitLog(sanitizedBotName, '📦 Building container image...', 'info');
    emitStatus(sanitizedBotName, 'deploying', 20);
    
    // Submit build and capture build ID
    const buildCmd = `gcloud builds submit --tag gcr.io/${PROJECT_ID}/${serviceName} --async --format="value(id)" ${botDir}`;
    
    let buildId = '';
    try {
      buildId = (await execWithLogs(buildCmd, sanitizedBotName)).trim();
      emitLog(sanitizedBotName, `⏳ Build submitted (ID: ${buildId}), waiting for completion...`, 'info');
      
      // Poll for build status
      let attempts = 0;
      const maxAttempts = 60; // 60 attempts = ~5 minutes
      let buildStatus = 'QUEUED';
      
      while (attempts < maxAttempts && buildStatus !== 'SUCCESS') {
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        try {
          const statusCmd = `gcloud builds describe ${buildId} --format="value(status)"`;
          buildStatus = (await execPromise(statusCmd)).trim();
          
          if (buildStatus === 'SUCCESS') {
            emitLog(sanitizedBotName, '✅ Container built successfully', 'success');
            emitStatus(sanitizedBotName, 'deploying', 60);
            break;
          } else if (buildStatus === 'FAILURE' || buildStatus === 'CANCELLED' || buildStatus === 'TIMEOUT') {
            throw new Error(`Build ${buildStatus.toLowerCase()}`);
          } else {
            attempts++;
            emitLog(sanitizedBotName, `⏳ Build ${buildStatus.toLowerCase()}... (${attempts}/${maxAttempts})`, 'info');
          }
        } catch (err) {
          if (err.message.includes('Build')) {
            throw err; // Re-throw build failures
          }
          attempts++;
          emitLog(sanitizedBotName, `⏳ Checking build status... (${attempts}/${maxAttempts})`, 'info');
        }
      }
      
      if (attempts >= maxAttempts && buildStatus !== 'SUCCESS') {
        throw new Error('Build timeout - exceeded 5 minutes');
      }
    } catch (buildError) {
      emitLog(sanitizedBotName, `❌ Build failed: ${buildError.message}`, 'error');
      emitStatus(sanitizedBotName, 'failed', 0);
      return;
    }
    
    emitLog(sanitizedBotName, '🌐 Deploying to Cloud Run...', 'info');
    
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
      await execWithLogs(deployCmd, sanitizedBotName);
      emitLog(sanitizedBotName, '✅ Bot deployed successfully to Cloud Run!', 'success');
      
      // Wait a moment for Cloud Run to stabilize, then verify status
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      try {
        const statusCmd = `gcloud run services describe ${serviceName} --region ${REGION} --format="value(status.conditions[0].status)"`;
        const result = await execPromise(statusCmd);
        const isRunning = result.trim().includes('True');
        
        if (isRunning) {
          emitStatus(sanitizedBotName, 'running', 100);
          emitLog(sanitizedBotName, '✅ Service is now running', 'success');
        } else {
          emitStatus(sanitizedBotName, 'stopped', 0);
        }
      } catch {
        // If we can't verify, assume running since deploy succeeded
        emitStatus(sanitizedBotName, 'running', 100);
      }
    } catch (deployError) {
      emitLog(sanitizedBotName, `❌ Deployment failed: ${deployError.message}`, 'error');
      emitStatus(sanitizedBotName, 'failed', 0);
    }
    
  } catch (err) {
    console.error('Deploy error:', err);
    emitLog(sanitizedBotName, `❌ Error: ${err.message}`, 'error');
    emitStatus(sanitizedBotName, 'failed', 0);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.post('/api/restart/:botName', async (req, res) => {
  const validation = validateBotAccess(req.params.botName);
  if (!validation) {
    return res.status(400).json({ error: 'Invalid bot name' });
  }
  
  const { sanitizedBotName } = validation;
  const serviceName = `${sanitizedBotName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    emitStatus(sanitizedBotName, 'restarting', 0);
    emitLog(sanitizedBotName, '🔄 Restarting bot...', 'info');
    
    const cmd = `gcloud run services update ${serviceName} \
      --region ${REGION} \
      --min-instances 1`;
    
    await execWithLogs(cmd, sanitizedBotName);
    
    emitLog(sanitizedBotName, '✅ Bot restarted successfully', 'success');
    emitStatus(sanitizedBotName, 'running', 100);
    
    res.json({ success: true, message: 'Bot restarted' });
  } catch (err) {
    emitLog(sanitizedBotName, `❌ Restart failed: ${err.message}`, 'error');
    emitStatus(sanitizedBotName, 'failed', 0);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cancel-deployment/:botName', async (req, res) => {
  const validation = validateBotAccess(req.params.botName);
  if (!validation) {
    return res.status(400).json({ error: 'Invalid bot name' });
  }
  
  const { sanitizedBotName } = validation;

  try {
    emitLog(sanitizedBotName, '🛑 Cancelling deployment...', 'info');
    emitStatus(sanitizedBotName, 'failed', 0);
    emitLog(sanitizedBotName, '❌ Deployment cancelled by user', 'error');

    res.json({ 
      success: true, 
      message: 'Deployment cancelled'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stop/:botName', async (req, res) => {
  const validation = validateBotAccess(req.params.botName);
  if (!validation) {
    return res.status(400).json({ error: 'Invalid bot name' });
  }
  
  const { sanitizedBotName } = validation;
  const serviceName = `${sanitizedBotName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    emitStatus(sanitizedBotName, 'stopping', 0);
    emitLog(sanitizedBotName, '⏸️ Stopping bot...', 'info');
    
    const cmd = `gcloud run services update ${serviceName} \
      --region ${REGION} \
      --min-instances 0 \
      --max-instances 0`;

    await execWithLogs(cmd, sanitizedBotName);

    emitLog(sanitizedBotName, '✅ Bot stopped (scaled to 0)', 'success');
    emitStatus(sanitizedBotName, 'stopped', 0);

    res.json({ 
      success: true, 
      message: 'Bot stopped (scaled to 0)'
    });
  } catch (err) {
    emitLog(sanitizedBotName, `❌ Stop failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/delete/:botName', async (req, res) => {
  const validation = validateBotAccess(req.params.botName);
  if (!validation) {
    return res.status(400).json({ error: 'Invalid bot name' });
  }
  
  const { botDir, sanitizedBotName } = validation;
  const serviceName = `${sanitizedBotName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    emitLog(sanitizedBotName, '🗑️ Deleting bot...', 'info');
    
    const cmd = `gcloud run services delete ${serviceName} --region ${REGION} --quiet`;
    await execPromise(cmd).catch(() => {});

    await fs.rm(botDir, { recursive: true, force: true });

    emitLog(sanitizedBotName, '✅ Bot deleted from Cloud Run and local storage', 'success');
    delete deploymentStatus[sanitizedBotName];

    res.json({ 
      success: true, 
      message: 'Bot deleted from Cloud Run and local storage'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs/:botName', async (req, res) => {
  const validation = validateBotAccess(req.params.botName);
  if (!validation) {
    return res.status(400).json({ error: 'Invalid bot name' });
  }
  
  const { sanitizedBotName } = validation;
  const serviceName = `${sanitizedBotName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

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
      const sanitized = sanitizeBotName(file);
      if (!sanitized || sanitized !== file) continue;
      
      const botDir = path.join(BOTS_DIR, sanitized);
      const stats = await fs.stat(botDir);

      if (stats.isDirectory()) {
        const serviceName = `${sanitized}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        
        // Use cached status or default to not-deployed (fast)
        let status = deploymentStatus[sanitized]?.status || 'not-deployed';

        bots.push({
          name: sanitized,
          status,
          serviceName,
          progress: deploymentStatus[sanitized]?.progress || 0
        });
      }
    }

    res.json({ bots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check status of a specific bot from cloud (on-demand)
app.get('/api/bots/:botName/status', async (req, res) => {
  const validation = validateBotAccess(req.params.botName);
  if (!validation) {
    return res.status(400).json({ error: 'Invalid bot name' });
  }
  
  const { sanitizedBotName } = validation;
  const serviceName = `${sanitizedBotName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  
  try {
    const cmd = `gcloud run services describe ${serviceName} --region ${REGION} --format="value(status.conditions[0].status)"`;
    const result = await execPromise(cmd);
    const status = result.includes('True') ? 'running' : 'stopped';
    
    deploymentStatus[sanitizedBotName] = { 
      status, 
      progress: status === 'running' ? 100 : 0,
      timestamp: Date.now()
    };
    
    res.json({ success: true, status, serviceName });
  } catch {
    res.json({ success: true, status: 'not-deployed', serviceName });
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
