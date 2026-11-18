const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const crypto = require('crypto');

const token = process.env.BOT_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const postbackSecret = process.env.POSTBACK_SECRET;

if (!token || !supabaseUrl || !supabaseKey) {
    throw new Error('Missing environment variables!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const bot = new TelegramBot(token, { polling: true });

const BOT_USERNAME = 'EarnNova_BD_bot';
const REFERRAL_BONUS = 1;

const MONETAG_ZONE_ID = '12287336';
const MONETAG_AD_ID = 1;
const AD_REWARD = 0.05;
const MINI_APP_ORIGIN = 'https://earnova-1.onrender.com';

const adminStates = new Map();
const userStates = new Map();

const PORT = process.env.PORT || 3000;


// HTTP HELPERS

function sendJson(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': MINI_APP_ORIGIN,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });

    res.end(JSON.stringify(data));
}

function sendText(res, status, message) {
    res.writeHead(status, {
        'Content-Type': 'text/plain'
    });

    res.end(message);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';

        req.on('data', chunk => {
            body += chunk;

            if (body.length > 100000) {
                reject(new Error('Request too large'));
                req.destroy();
            }
        });

        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            } catch (error) {
                reject(error);
            }
        });

        req.on('error', reject);
    });
}


// VERIFY TELEGRAM WEB APP INIT DATA

function verifyTelegramInitData(initData) {
    if (!initData || typeof initData !== 'string') {
        return null;
    }

    try {
        const params = new URLSearchParams(initData);
        const receivedHash = params.get('hash');

        if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
            return null;
        }

        const authDate = Number(params.get('auth_date'));

        if (!Number.isFinite(authDate)) {
            return null;
        }

        const now = Math.floor(Date.now() / 1000);

        if (authDate > now + 60 || now - authDate > 86400) {
            return null;
        }

        const entries = [];

        for (const [key, value] of params.entries()) {
            if (key !== 'hash' && key !== 'signature') {
                entries.push([key, value]);
            }
        }

        entries.sort((a, b) => a[0].localeCompare(b[0]));

        const dataCheckString = entries
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(token)
            .digest();

        const calculatedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest();

        const receivedBuffer = Buffer.from(receivedHash, 'hex');

        if (
            receivedBuffer.length !== calculatedHash.length ||
            !crypto.timingSafeEqual(receivedBuffer, calculatedHash)
        ) {
            return null;
        }

        const userString = params.get('user');

        if (!userString) {
            return null;
        }

        const user = JSON.parse(userString);

        if (!user.id || !Number.isSafeInteger(Number(user.id))) {
            return null;
        }

        return user;

    } catch (error) {
        console.error('Telegram initData verification error:', error.message);
        return null;
    }
}


// CREATE PENDING AD RECORD

async function startRewardedAd(req, res) {
    let body;

    try {
        body = await readBody(req);
    } catch (error) {
        return sendJson(res, 400, {
            success: false,
            message: 'Invalid request body'
        });
    }

    const telegramUser = verifyTelegramInitData(body.initData);

    if (!telegramUser) {
        return sendJson(res, 401, {
            success: false,
            message: 'Telegram verification failed'
        });
    }

    const verificationId = crypto.randomUUID();

    const { data, error } = await supabase
        .from('ad_views')
        .insert({
            telegram_id: telegramUser.id,
            ad_id: MONETAG_AD_ID,
            reward_amount: 0,
            status: 'pending',
            verification_id: verificationId
        })
        .select('verification_id')
        .single();

    if (error || !data) {
        console.error('Ad start database error:', error?.message);

        return sendJson(res, 500, {
            success: false,
            message: 'Could not start advertisement'
        });
    }

    console.log('Rewarded ad started:', {
        telegram_id: telegramUser.id,
        verification_id: verificationId
    });

    return sendJson(res, 200, {
        success: true,
        ymid: data.verification_id,
        zone_id: MONETAG_ZONE_ID,
        reward: AD_REWARD
    });
}


// MONETAG POSTBACK

function secretsMatch(received, expected) {
    if (!received || !expected) return false;

    const a = Buffer.from(String(received));
    const b = Buffer.from(String(expected));

    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleMonetagPostback(url, res) {
    if (!postbackSecret) {
        console.error('POSTBACK_SECRET is missing');

        return sendText(res, 503, 'Postback is not configured');
    }

    const receivedSecret = url.searchParams.get('secret');

    if (!secretsMatch(receivedSecret, postbackSecret)) {
        console.error('Rejected Monetag postback: invalid secret');

        return sendText(res, 403, 'Forbidden');
    }

    const ymid = url.searchParams.get('ymid');
    const telegramId = url.searchParams.get('telegram_id');
    const rewardEventType = url.searchParams.get('reward_event_type');
    const zoneId = url.searchParams.get('zone_id');

    if (!ymid) {
        return sendText(res, 400, 'Missing ymid');
    }

    if (zoneId && zoneId !== MONETAG_ZONE_ID) {
        return sendText(res, 400, 'Invalid zone');
    }

    // Only a confirmed valued event can receive a reward.
    if (rewardEventType !== 'valued') {
        console.log('Non-valued Monetag event ignored:', {
            ymid,
            rewardEventType
        });

        return sendText(res, 200, 'Event ignored');
    }

    // Verify that this ymid belongs to the supplied Telegram user.
    const { data: adRecord, error: lookupError } = await supabase
        .from('ad_views')
        .select('telegram_id, status')
        .eq('verification_id', ymid)
        .maybeSingle();

    if (lookupError) {
        console.error('Postback lookup error:', lookupError.message);

        return sendText(res, 500, 'Database error');
    }

    if (!adRecord) {
        console.error('Unknown Monetag ymid:', ymid);

        // Do not retry an unknown verification ID forever.
        return sendText(res, 200, 'Unknown event ignored');
    }

    if (
        telegramId &&
        String(adRecord.telegram_id) !== String(telegramId)
    ) {
        console.error('Telegram ID mismatch for postback:', ymid);

        return sendText(res, 403, 'User mismatch');
    }

    // Already verified means this is a duplicate postback.
    if (adRecord.status === 'verified') {
        console.log('Duplicate Monetag postback ignored:', ymid);

        return sendText(res, 200, 'Already processed');
    }

    if (adRecord.status !== 'pending') {
        return sendText(res, 200, 'Ad is not pending');
    }

    // The SQL function changes pending -> verified and credits the balance.
    const { data: rewarded, error: rewardError } = await supabase.rpc(
        'complete_rewarded_ad',
        {
            p_verification_id: ymid
        }
    );

    if (rewardError) {
        console.error('Monetag reward RPC error:', rewardError.message);

        return sendText(res, 500, 'Reward processing failed');
    }

    if (rewarded !== true) {
        console.log('Reward not applied; duplicate or invalid event:', ymid);

        return sendText(res, 200, 'No reward applied');
    }

    console.log('Monetag reward successfully credited:', {
        telegram_id: adRecord.telegram_id,
        ymid,
        reward: AD_REWARD
    });

    return sendText(res, 200, 'Reward credited');
}


// HTTP SERVER

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': MINI_APP_ORIGIN,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });

        return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/') {
        return sendText(res, 200, 'EarnNova Bot is running!');
    }

    if (req.method === 'POST' && url.pathname === '/ad/start') {
        try {
            return await startRewardedAd(req, res);
        } catch (error) {
            console.error('Ad start error:', error.message);

            return sendJson(res, 500, {
                success: false,
                message: 'Server error'
            });
        }
    }

    if (req.method === 'GET' && url.pathname === '/postback') {
        try {
            return await handleMonetagPostback(url, res);
        } catch (error) {
            console.error('Postback error:', error.message);

            return sendText(res, 500, 'Internal server error');
        }
    }

    return sendText(res, 404, 'Not found');
});

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


// REFERRAL REGISTRATION

async function registerReferral(userId, referralCode) {
    if (!referralCode) return;

    const { data: referrer, error: referrerError } = await supabase
        .from('users')
        .select('telegram_id')
        .eq('referral_code', referralCode)
        .maybeSingle();

    if (referrerError) {
        console.error('Referrer lookup error:', referrerError.message);
        return;
    }

    if (!referrer || Number(referrer.telegram_id) === Number(userId)) {
        return;
    }

    const { error } = await supabase
        .from('referrals')
        .insert({
            referrer_telegram_id: referrer.telegram_id,
            referred_telegram_id: userId,
            reward_amount: REFERRAL_BONUS,
            reward_paid: false
        });

    if (error && error.code !== '23505') {
        console.error('Referral registration error:', error.message);
    }
}


// START

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const user = msg.from;
    const chatId = msg.chat.id;

    try {
        const { error } = await supabase
            .from('users')
            .upsert({
                telegram_id: user.id,
                username: user.username || null,
                first_name: user.first_name || null
            }, { onConflict: 'telegram_id' });

        if (error) {
            console.error('User save error:', error.message);
            return bot.sendMessage(chatId, '⚠️ আপনার তথ্য সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।');
        }

        const startParameter = match && match[1]
            ? match[1].trim()
            : '';

        if (startParameter.startsWith('ref_')) {
            const referralCode = startParameter.substring(4);
            await registerReferral(user.id, referralCode);
        }

        const { error: userError } = await supabase
            .from('users')
            .select('referral_code')
            .eq('telegram_id', user.id)
            .single();

        if (userError) {
            console.error('Referral code lookup error:', userError.message);
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

    } catch (error) {
        console.error('Start error:', error);
        bot.sendMessage(chatId, '⚠️ সমস্যা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।');
    }
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
                '❌ আপনার উত্তরটি সঠিক হয়নি। চিন্তা করবেন না, আবার চেষ্টা করুন। 😊'
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

        const { data: completedTask, error: taskError } = await supabase
            .from('tasks')
            .select('reward_amount, title')
            .eq('id', userState.taskId)
            .maybeSingle();

        if (taskError || !completedTask) {
            console.error('Completed task lookup error:', taskError?.message);
            return bot.sendMessage(chatId, '🎉 অভিনন্দন! আপনার Task সম্পন্ন হয়েছে এবং Reward যোগ হয়েছে।');
        }

        let referralMessage = '';

        const { data: referral, error: referralLookupError } = await supabase
            .from('referrals')
            .select('referrer_telegram_id')
            .eq('referred_telegram_id', userId)
            .eq('reward_paid', false)
            .maybeSingle();

        if (referralLookupError) {
            console.error('Referral lookup error:', referralLookupError.message);
        } else if (referral) {
            const { data: bonus, error: bonusError } = await supabase.rpc(
                'award_referral_bonus',
                {
                    p_referred_telegram_id: userId
                }
            );

            if (bonusError) {
                console.error('Referral bonus error:', bonusError.message);
            } else if (Number(bonus) > 0) {
                referralMessage = '\n\n👥 আপনার আমন্ত্রণে একজন বন্ধু প্রথম Task সম্পন্ন করেছে। রেফারকারীকে ১ টাকা বোনাস দেওয়া হয়েছে।';

                try {
                    await bot.sendMessage(
                        referral.referrer_telegram_id,
                        `🎉 অভিনন্দন!\n\nআপনার আমন্ত্রণে একজন বন্ধু প্রথম Task সম্পন্ন করেছে।\n💰 Referral Bonus: ৳${Number(bonus).toFixed(2)}`
                    );
                } catch (notifyError) {
                    console.error('Referrer notification error:', notifyError.message);
                }
            }
        }

        return bot.sendMessage(
            chatId,
            `🎉 অভিনন্দন!\n\nআপনি প্রশ্নটির সঠিক উত্তর দিয়েছেন!\n\n💰 আপনার প্রাপ্ত Reward: ৳${Number(completedTask.reward_amount).toFixed(2)}\n✅ Reward আপনার Balance-এ যোগ হয়েছে।${referralMessage}\n\nEarnNova-এর সঙ্গে থাকার জন্য ধন্যবাদ! ❤️`
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
            `💰 আপনার বর্তমান ব্যালেন্স: ৳${Number(data.balance || 0).toFixed(2)}`
        );
    }

    // TASK MENU

    if (text === '📌 টাস্ক') {
        return showTasks(chatId, userId);
    }

    // REFERRAL MENU

    if (text === '👥 বন্ধু আমন্ত্রণ') {
        const { data: userData, error } = await supabase
            .from('users')
            .select('referral_code')
            .eq('telegram_id', userId)
            .single();

        if (error || !userData?.referral_code) {
            console.error('Referral code error:', error?.message);
            return bot.sendMessage(chatId, '⚠️ Referral Link তৈরি করা যায়নি।');
        }

        const referralLink =
            `https://t.me/${BOT_USERNAME}?start=ref_${userData.referral_code}`;

        const { count: totalCount, error: totalError } = await supabase
            .from('referrals')
            .select('*', { count: 'exact', head: true })
            .eq('referrer_telegram_id', userId);

        const { count: validCount, error: validError } = await supabase
            .from('referrals')
            .select('*', { count: 'exact', head: true })
            .eq('referrer_telegram_id', userId)
            .eq('reward_paid', true);

        const { count: pendingCount, error: pendingError } = await supabase
            .from('referrals')
            .select('*', { count: 'exact', head: true })
            .eq('referrer_telegram_id', userId)
            .eq('reward_paid', false);

        if (totalError || validError || pendingError) {
            console.error('Referral count error:', {
                totalError,
                validError,
                pendingError
            });

            return bot.sendMessage(
                chatId,
                '⚠️ Referral-এর হিসাব দেখানো যাচ্ছে না। একটু পরে চেষ্টা করুন।'
            );
        }

        return bot.sendMessage(chatId, `
👥 বন্ধু আমন্ত্রণ

আপনার Referral Link:

${referralLink}

🎁 আপনার লিংক দিয়ে বন্ধু যোগ দিয়ে প্রথম Task সম্পন্ন করলে আপনি পাবেন ৳1.00।

👤 মোট আমন্ত্রিত বন্ধু: ${totalCount || 0}

✅ Valid Referral: ${validCount || 0}

⏳ Pending Referral: ${pendingCount || 0}

📢 আপনার বন্ধুদের সঙ্গে লিংকটি শেয়ার করুন।
        `, {
            reply_markup: {
                inline_keyboard: [[
                    {
                        text: '📤 Referral Link শেয়ার করুন',
                        url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('EarnNova-তে যোগ দিন এবং Task সম্পন্ন করে Reward অর্জন করুন!')}`
                    }
                ]]
            }
        });
    }

    // TRANSACTION HISTORY

    if (text === '📜 লেনদেনের ইতিহাস') {
        const { data: transactions, error } = await supabase
            .from('transactions')
            .select('transaction_type, direction, amount, status, description, created_at')
            .eq('telegram_id', userId)
            .order('created_at', { ascending: false })
            .limit(10);

        if (error) {
            console.error('Transaction history error:', error.message);
            return bot.sendMessage(chatId, '⚠️ লেনদেনের ইতিহাস পাওয়া যাচ্ছে না।');
        }

        if (!transactions || transactions.length === 0) {
            return bot.sendMessage(chatId, '📜 এখনো কোনো লেনদেন নেই।');
        }

        const history = transactions.map((item, index) => {
            const sign = item.direction === 'credit' ? '+' : '-';
            return `${index + 1}. ${item.description || item.transaction_type}\n${sign}৳${Number(item.amount).toFixed(2)} — ${item.status}`;
        }).join('\n\n');

        return bot.sendMessage(chatId, `📜 আপনার সাম্প্রতিক লেনদেন:\n\n${history}`);
    }

    // OTHER MENU

    const replies = {
        '📢 বিজ্ঞাপন দেখুন': '📢 বিজ্ঞাপন চালু করার প্রস্তুতি চলছে। Mini App থেকে বিজ্ঞাপন দেখতে পারবেন।',
        '💳 টাকা উত্তোলন': '💳 উত্তোলন ব্যবস্থা শিগগিরই চালু হবে।'
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