const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');

const token = process.env.BOT_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!token || !supabaseUrl || !supabaseKey) {
    throw new Error('Missing environment variables!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const bot = new TelegramBot(token, { polling: true });

const adminStates = new Map();
const userStates = new Map();

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('EarnNova Bot is running!');
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`EarnNova server running on port ${PORT}`);
});

// ADMIN CHECK
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

// START
bot.onText(/\/start(?:\s|$)/, async (msg) => {
    const user = msg.from;
    const chatId = msg.chat.id;

    const { error } = await supabase
        .from('users')
        .upsert({
            telegram_id: user.id,
            username: user.username || null,
            first_name: user.first_name || null
        }, { onConflict: 'telegram_id' });

    if (error) {
        console.error('User save error:', error.message);
    }

    userStates.delete(user.id);
    adminStates.delete(user.id);

    await bot.sendMessage(chatId, `
🌟 স্বাগতম EarnNova-তে!

এখানে বিভিন্ন টাস্ক সম্পন্ন করে রিওয়ার্ড অর্জনের সুযোগ পাবেন।

👇 নিচের মেনু থেকে পছন্দের অপশন বেছে নিন।
    `, {
        reply_markup: {
            keyboard: [
                ['📢 বিজ্ঞাপন দেখুন', '📌 টাস্ক'],
                ['💰 আমার ব্যালেন্স', '👥 বন্ধু আমন্ত্রণ'],
                ['💳 টাকা উত্তোলন', '📜 লেনদেনের ইতিহাস']
            ],
            resize_keyboard: true
        }
    });
});

// ADMIN PANEL
bot.onText(/\/admin(?:\s|$)/, async (msg) => {
    const userId = msg.from.id;

    if (!(await isAdmin(userId))) {
        return bot.sendMessage(msg.chat.id, '⛔ আপনার Admin অনুমতি নেই।');
    }

    userStates.delete(userId);
    adminStates.delete(userId);

    await bot.sendMessage(msg.chat.id, '🔐 EarnNova Admin Panel', {
        reply_markup: {
            keyboard: [
                ['➕ নতুন টাস্ক যোগ করুন'],
                ['❌ বাতিল']
            ],
            resize_keyboard: true
        }
    });
});

// SHOW TASKS
async function showTasks(chatId, userId) {
    const { data: tasks, error } = await supabase
        .from('tasks')
        .select('id, title, description, reward_amount')
        .eq('is_active', true)
        .order('id', { ascending: true });

    if (error) {
        console.error('Task list error:', error.message);
        return bot.sendMessage(chatId, '⚠️ টাস্ক লোড করা যায়নি।');
    }

    if (!tasks || tasks.length === 0) {
        return bot.sendMessage(chatId, '📌 বর্তমানে কোনো Active Task নেই।');
    }

    const { data: completed, error: completedError } = await supabase
        .from('user_tasks')
        .select('task_id')
        .eq('telegram_id', userId)
        .eq('status', 'completed');

    if (completedError) {
        console.error('Completed tasks error:', completedError.message);
        return bot.sendMessage(chatId, '⚠️ টাস্কের তথ্য পাওয়া যায়নি।');
    }

    const completedIds = new Set(
        (completed || []).map(item => item.task_id)
    );

    const buttons = tasks.map(task => [{
        text: completedIds.has(task.id)
            ? `✅ ${task.title} (সম্পন্ন)`
            : `📌 ${task.title} — ${Number(task.reward_amount).toFixed(2)} টাকা`,
        callback_data: `task_${task.id}`
    }]);

    return bot.sendMessage(chatId, '📋 উপলব্ধ Task-গুলো নিচে দেওয়া হলো।', {
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

// TASK BUTTON
bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat?.id;
    const userId = query.from.id;
    const data = query.data || '';

    await bot.answerCallbackQuery(query.id);

    if (!chatId || !data.startsWith('task_')) return;

    const taskId = Number(data.replace('task_', ''));

    if (!Number.isInteger(taskId) || taskId <= 0) return;

    const { data: task, error } = await supabase
        .from('tasks')
        .select('id, title, description, reward_amount')
        .eq('id', taskId)
        .eq('is_active', true)
        .maybeSingle();

    if (error || !task) {
        return bot.sendMessage(chatId, '⚠️ এই Task পাওয়া যাচ্ছে না।');
    }

    const { data: previous, error: previousError } = await supabase
        .from('user_tasks')
        .select('id')
        .eq('telegram_id', userId)
        .eq('task_id', taskId)
        .eq('status', 'completed')
        .maybeSingle();

    if (previousError) {
        console.error('Previous task check error:', previousError.message);
        return bot.sendMessage(chatId, '⚠️ Task-এর তথ্য পাওয়া যাচ্ছে না।');
    }

    if (previous) {
        return bot.sendMessage(chatId, '✅ আপনি এই Task আগেই সম্পন্ন করেছেন।');
    }

    userStates.set(userId, {
        step: 'answer',
        taskId: taskId
    });

    await bot.sendMessage(chatId, `
📌 ${task.title}

📄 ${task.description}

💰 Reward: ${Number(task.reward_amount).toFixed(2)} টাকা

✍️ সঠিক উত্তরটি বাংলায় লিখুন:
    `);
});

// MAIN MESSAGE HANDLER
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    // CANCEL
    if (text === '❌ বাতিল') {
        adminStates.delete(userId);
        userStates.delete(userId);

        return bot.sendMessage(chatId, '❌ কাজ বাতিল করা হয়েছে।');
    }

    // CREATE TASK
    if (text === '➕ নতুন টাস্ক যোগ করুন') {
        if (!(await isAdmin(userId))) {
            return bot.sendMessage(chatId, '⛔ Admin অনুমতি নেই।');
        }

        userStates.delete(userId);

        adminStates.set(userId, {
            step: 'title'
        });

        return bot.sendMessage(chatId, '📝 নতুন টাস্কের নাম লিখুন:');
    }

    // ADMIN TASK CREATION
    const adminState = adminStates.get(userId);

    if (adminState) {
        if (!(await isAdmin(userId))) {
            adminStates.delete(userId);
            return bot.sendMessage(chatId, '⛔ Admin অনুমতি নেই।');
        }

        if (adminState.step === 'title') {
            if (!text.trim()) {
                return bot.sendMessage(chatId, '⚠️ টাস্কের নাম লিখুন।');
            }

            adminState.title = text.trim();
            adminState.step = 'description';

            return bot.sendMessage(chatId, '📄 টাস্কের প্রশ্ন বা বিবরণ লিখুন:');
        }

        if (adminState.step === 'description') {
            if (!text.trim()) {
                return bot.sendMessage(chatId, '⚠️ প্রশ্ন বা বিবরণ লিখুন।');
            }

            adminState.description = text.trim();
            adminState.step = 'answer';

            return bot.sendMessage(chatId, `
✅ এই Task-এর সব গ্রহণযোগ্য সঠিক উত্তর কমা দিয়ে লিখুন।

উদাহরণ:
শাপলা, সাপলা, shapla, shapola
            `);
        }

        if (adminState.step === 'answer') {
            const answers = text
                .split(',')
                .map(answer => answer.trim())
                .filter(answer => answer.length > 0);

            if (answers.length === 0) {
                return bot.sendMessage(chatId, '⚠️ অন্তত একটি সঠিক উত্তর লিখুন।');
            }

            adminState.correctAnswer = answers.join(', ');
            adminState.step = 'reward';

            return bot.sendMessage(chatId, '💰 Reward কত টাকা হবে? যেমন: 2 অথবা 5.50');
        }

        if (adminState.step === 'reward') {
            const reward = Number(text.trim());

            if (!Number.isFinite(reward) || reward <= 0) {
                return bot.sendMessage(chatId, '⚠️ সঠিক Amount লিখুন। যেমন: 2 অথবা 5.50');
            }

            const { data, error } = await supabase
                .from('tasks')
                .insert({
                    title: adminState.title,
                    description: adminState.description,
                    correct_answer: adminState.correctAnswer,
                    reward_amount: reward,
                    is_active: true
                })
                .select()
                .single();

            if (error) {
                console.error('Task creation error:', error.message);
                adminStates.delete(userId);

                return bot.sendMessage(chatId, '❌ টাস্ক যোগ করা যায়নি।');
            }

            adminStates.delete(userId);

            return bot.sendMessage(chatId, `
✅ নতুন Task সফলভাবে যোগ হয়েছে!

🆔 ID: ${data.id}
📝 নাম: ${data.title}
💰 Reward: ${Number(data.reward_amount).toFixed(2)} টাকা
            `);
        }
    }

    // USER TASK ANSWER
    const userState = userStates.get(userId);

    if (userState && userState.step === 'answer') {
        const { data: result, error: rewardError } = await supabase.rpc(
            'complete_task',
            {
                p_telegram_id: userId,
                p_task_id: userState.taskId,
                p_answer: text.trim()
            }
        );

        if (rewardError) {
            console.error('Reward error:', rewardError.message);

            return bot.sendMessage(
                chatId,
                '⚠️ Reward যোগ করা যায়নি। Admin-কে জানান।'
            );
        }

        if (result === 'wrong_answer') {
            return bot.sendMessage(
                chatId,
                '❌ উত্তর সঠিক হয়নি। আবার চেষ্টা করুন।'
            );
        }

        userStates.delete(userId);

        if (result === 'already_completed') {
            return bot.sendMessage(
                chatId,
                '✅ এই Task-এর Reward আপনি আগেই পেয়েছেন।'
            );
        }

        if (result === 'task_not_found') {
            return bot.sendMessage(
                chatId,
                '⚠️ এই Task আর Active নেই।'
            );
        }

        if (result !== 'success') {
            return bot.sendMessage(
                chatId,
                '⚠️ Task সম্পন্ন করা যায়নি।'
            );
        }

        return bot.sendMessage(
            chatId,
            '🎉 অভিনন্দন! সঠিক উত্তর দিয়েছেন। Reward আপনার Balance-এ যোগ হয়েছে।'
        );
    }

    // BALANCE
    if (text === '💰 আমার ব্যালেন্স') {
        const { data, error } = await supabase
            .from('users')
            .select('balance')
            .eq('telegram_id', userId)
            .single();

        if (error) {
            console.error('Balance error:', error.message);
            return bot.sendMessage(chatId, '⚠️ ব্যালেন্স দেখানো যাচ্ছে না।');
        }

        return bot.sendMessage(
            chatId,
            `💰 আপনার বর্তমান ব্যালেন্স: ${Number(data.balance || 0).toFixed(2)} টাকা`
        );
    }

    // TASK MENU
    if (text === '📌 টাস্ক') {
        return showTasks(chatId, userId);
    }

    // OTHER MENU
    const replies = {
        '📢 বিজ্ঞাপন দেখুন': '📢 বিজ্ঞাপন ব্যবস্থা শিগগিরই চালু হবে।',
        '👥 বন্ধু আমন্ত্রণ': '👥 রেফারেল ব্যবস্থা শিগগিরই চালু হবে।',
        '💳 টাকা উত্তোলন': '💳 উত্তোলন ব্যবস্থা শিগগিরই চালু হবে।',
        '📜 লেনদেনের ইতিহাস': '📜 এখনো কোনো লেনদেন নেই।'
    };

    if (replies[text]) {
        return bot.sendMessage(chatId, replies[text]);
    }
});

// POLLING ERROR
bot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error.message);
});

console.log('EarnNova Bot is running!');