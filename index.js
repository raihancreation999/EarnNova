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

// Admin Task Creation State
const adminStates = new Map();

// HTTP Server
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('EarnNova Bot is running!');
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`EarnNova server running on port ${PORT}`);
});

// Check Admin
async function isAdmin(telegramId) {
    const { data, error } = await supabase
        .from('admins')
        .select('role')
        .eq('telegram_id', telegramId)
        .eq('is_active', true)
        .maybeSingle();

    if (error) {
        console.error('Admin check error:', error.message);
        return false;
    }

    return !!data;
}

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

// Admin Command
bot.onText(/\/admin(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!(await isAdmin(userId))) {
        return bot.sendMessage(chatId, '⛔ আপনার Admin অনুমতি নেই।');
    }

    bot.sendMessage(chatId, `
🔐 EarnNova Admin Panel

স্বাগতম Super Admin!

এখান থেকে আপনি নতুন টাস্ক যোগ করতে পারবেন।
    `, {
        reply_markup: {
            keyboard: [
                ['➕ নতুন টাস্ক যোগ করুন'],
                ['❌ বাতিল']
            ],
            resize_keyboard: true
        }
    });
});

// Menu Buttons
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from.id;

    if (!text || text.startsWith('/')) return;

    // Cancel
    if (text === '❌ বাতিল') {
        adminStates.delete(userId);
        return bot.sendMessage(chatId, '❌ কাজ বাতিল করা হয়েছে।');
    }

    // New Task Button
    if (text === '➕ নতুন টাস্ক যোগ করুন') {
        if (!(await isAdmin(userId))) {
            return bot.sendMessage(chatId, '⛔ Admin অনুমতি নেই।');
        }

        adminStates.set(userId, { step: 'title' });

        return bot.sendMessage(chatId, '📝 নতুন টাস্কের নাম লিখুন:');
    }

    // Admin Task Creation
    const state = adminStates.get(userId);

    if (state) {
        if (!(await isAdmin(userId))) {
            adminStates.delete(userId);
            return bot.sendMessage(chatId, '⛔ Admin অনুমতি নেই।');
        }

        if (state.step === 'title') {
            state.title = text.trim();

            if (!state.title) {
                return bot.sendMessage(chatId, 'টাস্কের নাম লিখুন।');
            }

            state.step = 'description';

            return bot.sendMessage(chatId, '📄 এবার টাস্কের বিবরণ লিখুন:');
        }

        if (state.step === 'description') {
            state.description = text.trim();

            if (!state.description) {
                return bot.sendMessage(chatId, 'টাস্কের বিবরণ লিখুন।');
            }

            state.step = 'reward';

            return bot.sendMessage(
                chatId,
                '💰 এই টাস্কের Reward কত টাকা হবে? শুধু সংখ্যা লিখুন।'
            );
        }

        if (state.step === 'reward') {
            const reward = Number(text.trim());

            if (!Number.isFinite(reward) || reward <= 0) {
                return bot.sendMessage(
                    chatId,
                    '⚠️ সঠিক Reward লিখুন। যেমন: 2 অথবা 5.50'
                );
            }

            try {
                const { data, error } = await supabase
                    .from('tasks')
                    .insert({
                        title: state.title,
                        description: state.description,
                        reward_amount: reward,
                        is_active: true
                    })
                    .select()
                    .single();

                if (error) {
                    console.error('Task creation error:', error.message);

                    adminStates.delete(userId);

                    return bot.sendMessage(
                        chatId,
                        '❌ টাস্ক যোগ করা যায়নি। আবার চেষ্টা করুন।'
                    );
                }

                adminStates.delete(userId);

                return bot.sendMessage(chatId, `
✅ নতুন টাস্ক সফলভাবে যোগ হয়েছে!

🆔 Task ID: ${data.id}
📝 নাম: ${data.title}
📄 বিবরণ: ${data.description}
💰 Reward: ${Number(data.reward_amount).toFixed(2)} টাকা

📌 টাস্কটি Database-এ সংরক্ষিত হয়েছে।
                `);

            } catch (error) {
                console.error('Task error:', error.message);
                adminStates.delete(userId);

                return bot.sendMessage(
                    chatId,
                    '❌ একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।'
                );
            }
        }

        return;
    }

    // Balance System
    if (text === '💰 আমার ব্যালেন্স') {
        try {
            const { data, error } = await supabase
                .from('users')
                .select('balance')
                .eq('telegram_id', userId)
                .single();

            if (error) {
                console.error('Balance error:', error.message);

                return bot.sendMessage(
                    chatId,
                    '⚠️ ব্যালেন্স দেখাতে সমস্যা হয়েছে।'
                );
            }

            const balance = Number(data.balance || 0);

            return bot.sendMessage(
                chatId,
                `💰 আপনার বর্তমান ব্যালেন্স: ${balance.toFixed(2)} টাকা`
            );

        } catch (error) {
            console.error('Balance error:', error.message);

            return bot.sendMessage(
                chatId,
                '⚠️ ব্যালেন্স দেখানো যাচ্ছে না।'
            );
        }
    }

    // Other Menu Buttons
    const replies = {
        '📢 বিজ্ঞাপন দেখুন': '📢 বিজ্ঞাপন ব্যবস্থা শিগগিরই চালু হবে।',
        '📌 টাস্ক': '📌 টাস্ক ব্যবস্থা শিগগিরই চালু হবে।',
        '👥 বন্ধু আমন্ত্রণ': '👥 রেফারেল ব্যবস্থা শিগগিরই চালু হবে।',
        '💳 টাকা উত্তোলন': '💳 উত্তোলন ব্যবস্থা শিগগিরই চালু হবে।',
        '📜 লেনদেনের ইতিহাস': '📜 এখনো কোনো লেনদেন নেই।'
    };

    if (replies[text]) {
        bot.sendMessage(chatId, replies[text]);
    }
});

// Polling Error
bot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error.message);
});

console.log('EarnNova Bot is running!');