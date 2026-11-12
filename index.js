const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');

// Environment Variables
const token = process.env.BOT_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!token) {
    throw new Error('BOT_TOKEN is missing!');
}

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase credentials are missing!');
}

// Supabase Connection
const supabase = createClient(supabaseUrl, supabaseKey);

// Telegram Bot
const bot = new TelegramBot(token, { polling: true });

// HTTP Server
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('EarnNova Bot is running!');
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`EarnNova server running on port ${PORT}`);
});

// Start Command
bot.onText(/\/start(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        const { error } = await supabase
            .from('users')
            .upsert({
                telegram_id: user.id,
                username: user.username || null,
                first_name: user.first_name || null
            }, {
                onConflict: 'telegram_id'
            });

        if (error) {
            console.error('Supabase user error:', error.message);
        } else {
            console.log(`User saved: ${user.id}`);
        }

    } catch (error) {
        console.error('Database error:', error.message);
    }

    const welcomeMessage = `
🌟 স্বাগতম EarnNova-তে!

এখানে বিজ্ঞাপন দেখে, বিভিন্ন টাস্ক সম্পন্ন করে এবং বন্ধুদের আমন্ত্রণ করে রিওয়ার্ড অর্জনের সুযোগ পাবেন।

👇 নিচের মেনু থেকে আপনার পছন্দের অপশন বেছে নিন।
    `;

    const options = {
        reply_markup: {
            keyboard: [
                ['📢 বিজ্ঞাপন দেখুন', '📌 টাস্ক'],
                ['💰 আমার ব্যালেন্স', '👥 বন্ধু আমন্ত্রণ'],
                ['💳 টাকা উত্তোলন', '📜 লেনদেনের ইতিহাস']
            ],
            resize_keyboard: true
        }
    };

    bot.sendMessage(chatId, welcomeMessage, options);
});

// Menu Buttons
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    const replies = {
        '📢 বিজ্ঞাপন দেখুন': '📢 বিজ্ঞাপন ব্যবস্থা শিগগিরই চালু হবে।',
        '📌 টাস্ক': '📌 টাস্ক ব্যবস্থা শিগগিরই চালু হবে।',
        '💰 আমার ব্যালেন্স': '💰 আপনার ব্যালেন্স: 0.00 টাকা',
        '👥 বন্ধু আমন্ত্রণ': '👥 রেফারেল ব্যবস্থা শিগগিরই চালু হবে।',
        '💳 টাকা উত্তোলন': '💳 উত্তোলন ব্যবস্থা শিগগিরই চালু হবে।',
        '📜 লেনদেনের ইতিহাস': '📜 এখনো কোনো লেনদেন নেই।'
    };

    if (replies[text]) {
        bot.sendMessage(chatId, replies[text]);
    }
});

bot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error.message);
});

console.log('EarnNova Bot is running!');