const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const BOTS_DIR = './bots';
const PROJECT_ID = 'elitehost-480108'; // Change this
const REGION = 'us-central1'; // Change if needed

// Ensure bots directory exists
(async () => {
  try {
    await fs.mkdir(BOTS_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create bots directory:', err);
  }
})();

// Upload bot file
app.post('/api/upload', upload.single('botFile'), async (req, res) => {
  try {
    const { file } = req;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const botName = path.basename(file.originalname, '.js');
    const botDir = path.join(BOTS_DIR, botName);

    await fs.mkdir(botDir, { recursive: true });

    // Move uploaded file
    const content = await fs.readFile(file.path, 'utf8');
    await fs.writeFile(path.join(botDir, 'index.js'), content);
    await fs.unlink(file.path);

    // Create package.json if doesn't exist
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

    // Create Dockerfile
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

// Deploy bot to Google Cloud Run
app.post('/api/deploy/:botName', async (req, res) => {
  const { botName } = req.params;
  const botDir = path.join(BOTS_DIR, botName);

  try {
    // Check if bot exists
    await fs.access(botDir);

    const serviceName = `${botName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const logs = [];

    logs.push('Starting deployment to Google Cloud Run...');

    // Build container with Cloud Build
    const buildCmd = `gcloud builds submit --tag gcr.io/${PROJECT_ID}/${serviceName} ${botDir}`;

    await execPromise(buildCmd, (output) => {
      logs.push(output);
    });

    logs.push('Container built successfully');

    // Deploy to Cloud Run
    const deployCmd = `gcloud run deploy ${serviceName} \
      --image gcr.io/${PROJECT_ID}/${serviceName} \
      --platform managed \
      --region ${REGION} \
      --allow-unauthenticated \
      --min-instances 0 \
      --max-instances 1 \
      --memory 256Mi \
      --cpu 1`;

    await execPromise(deployCmd, (output) => {
      logs.push(output);
    });

    logs.push('✅ Bot deployed successfully to Cloud Run');

    res.json({ 
      success: true, 
      logs,
      serviceName 
    });
  } catch (err) {
    console.error('Deploy error:', err);
    res.status(500).json({ 
      error: err.message,
      logs: err.logs || []
    });
  }
});

// Stop bot (scale to 0)
app.post('/api/stop/:botName', async (req, res) => {
  const { botName } = req.params;
  const serviceName = `${botName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    const cmd = `gcloud run services update ${serviceName} \
      --region ${REGION} \
      --min-instances 0 \
      --max-instances 0`;

    const output = await execPromise(cmd);

    res.json({ 
      success: true, 
      message: 'Bot stopped (scaled to 0)',
      output
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete bot
app.delete('/api/delete/:botName', async (req, res) => {
  const { botName } = req.params;
  const serviceName = `${botName}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const botDir = path.join(BOTS_DIR, botName);

  try {
    // Delete from Cloud Run
    const cmd = `gcloud run services delete ${serviceName} --region ${REGION} --quiet`;
    await execPromise(cmd).catch(() => {
      // Ignore if service doesn't exist
    });

    // Delete local files
    await fs.rm(botDir, { recursive: true, force: true });

    res.json({ 
      success: true, 
      message: 'Bot deleted from Cloud Run and local storage'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get bot logs
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

// List all bots
app.get('/api/bots', async (req, res) => {
  try {
    const files = await fs.readdir(BOTS_DIR);
    const bots = [];

    for (const file of files) {
      const botDir = path.join(BOTS_DIR, file);
      const stats = await fs.stat(botDir);

      if (stats.isDirectory()) {
        const serviceName = `${file}-bot`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

        // Check if deployed
        let status = 'stopped';
        try {
          const cmd = `gcloud run services describe ${serviceName} --region ${REGION} --format="value(status.conditions[0].status)"`;
          const result = await execPromise(cmd);
          status = result.includes('True') ? 'running' : 'stopped';
        } catch {
          status = 'not-deployed';
        }

        bots.push({
          name: file,
          status,
          serviceName
        });
      }
    }

    res.json({ bots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper function to execute commands
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot Manager Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
});