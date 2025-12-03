const TelegramBot = require('node-telegram-bot-api');

const token = '7972032417:AAHSK8NckZL6Y-xA8zf0kOOrSceDVdYJgXs';
const bot = new TelegramBot(token, { polling: true });

// Welcome message on /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'there';
  bot.sendMessage(chatId, `Hello ${name}! 👋\n\nI'm your test bot. Try these commands:\n/help - Show commands\n/time - Get current time\n/echo [text] - I'll repeat what you say`);
});

// Help command
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `📋 Available Commands:\n\n/start - Start the bot\n/help - Show this help\n/time - Current server time\n/echo [text] - Echo your message\n\nOr just send any message and I'll reply!`);
});

// Time command
bot.onText(/\/time/, (msg) => {
  const now = new Date().toLocaleString();
  bot.sendMessage(msg.chat.id, `🕐 Current time: ${now}`);
});

// Echo command
bot.onText(/\/echo (.+)/, (msg, match) => {
  const text = match[1];
  bot.sendMessage(msg.chat.id, `🔊 ${text}`);
});

// Reply to any other message
bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const responses = [
    `You said: "${msg.text}"`,
    `Interesting! Tell me more about "${msg.text}"`,
    `Got it! "${msg.text}" 👍`,
    `I heard you say: ${msg.text}`
  ];
  
  const randomResponse = responses[Math.floor(Math.random() * responses.length)];
  bot.sendMessage(msg.chat.id, randomResponse);
});

console.log('🤖 Bot is running...');