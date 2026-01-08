const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

// =======================================================
// ⚙️ CONFIGURATION
// =======================================================
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = new line.Client(config);

// =======================================================
// 🚀 MAIN HANDLER
// =======================================================
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if (!req.body || !req.body.events) return res.status(200).json({ ok: true });

    try {
        await Promise.all(req.body.events.map(event => handleEvent(event)));
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('Handler Error:', err);
        res.status(500).end();
    }
}

// =======================================================
// 🎮 EVENT ROUTER
// =======================================================
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;

    const userId = event.source.userId;
    const text = event.message.text.trim();

    const isNumberOnly = /^\d+$/.test(text);
    const isTrackCommand = text.startsWith('ติดตามคิว');

    if (isNumberOnly || isTrackCommand) {
        return await processQueueTracking(event, userId, text, isNumberOnly);
    } else if (text === 'หยุด') {
        return await processStopTracking(event, userId);
    } else if (text === 'ล่าสุด' || text === 'ประวัติ') {
        return await processViewHistory(event);
    } else {
        return await sendWelcomeMenu(event);
    }
}

// =======================================================
// 🧠 BUSINESS LOGIC
// =======================================================

async function processQueueTracking(event, userId, text, isNumberOnly) {
    if (await isQuotaFull()) {
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⚠️ ขณะนี้โควต้า LINE เต็มแล้ว กรุณาใช้ Telegram: https://t.me/NakhonsawanLandBot`
        });
    }

    let queueInput = isNumberOnly ? text : text.replace('ติดตามคิว', '').trim();
    if (!queueInput || isNaN(queueInput)) {
        return client.replyMessage(event.replyToken, {
            type: 'text', text: "❌ กรุณาระบุเลขคิวให้ถูกต้อง เช่น '4012'"
        });
    }
    const targetQueue = parseInt(queueInput);
    const status = await getSmartQueueStatus(targetQueue);

    const { error } = await supabase.from('line_trackers').upsert({ 
        user_id: userId, 
        tracking_queue: targetQueue 
    });

    if (error) {
        console.error("DB Error:", error);
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ ระบบขัดข้อง กรุณาลองใหม่" });
    }

    const flexMessage = generateStatusFlex(targetQueue, status);
    return client.replyMessage(event.replyToken, flexMessage);
}

async function processStopTracking(event, userId) {
    await supabase.from('line_trackers').delete().eq('user_id', userId);
    return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '❌ ยกเลิกการติดตามเรียบร้อยแล้ว' 
    });
}

async function processViewHistory(event) {
    try {
        const { data: logs } = await supabase
            .from('queue_snapshots')
            .select('current_queue, current_counter, created_at')
            .order('created_at', { ascending: false })
            .limit(10);

        if (!logs || logs.length === 0) {
            return client.replyMessage(event.replyToken, { type: 'text', text: "⏳ ยังไม่มีข้อมูลการเรียกคิวในวันนี้" });
        }

        const flexMessage = generateHistoryFlex(logs);
        return client.replyMessage(event.replyToken, flexMessage);

    } catch (e) {
        console.error("History Error:", e);
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ ไม่สามารถดึงข้อมูลได้" });
    }
}

async function sendWelcomeMenu(event) {
    return client.replyMessage(event.replyToken, {
        type: 'flex',
        altText: 'เมนูหลัก',
        contents: {
            type: "bubble",
            hero: {
                type: "image",
                url: "https://cdn-icons-png.flaticon.com/512/3135/3135715.png",
                size: "full",
                aspectRatio: "20:13",
                aspectMode: "cover",
                backgroundColor: "#eeeeee"
            },
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "ระบบติดตามคิวที่ดิน", weight: "bold", size: "xl", color: "#1DB446" },
                    { type: "text", text: "จ.นครสวรรค์", weight: "bold", size: "md", margin: "sm" },
                    { type: "separator", margin: "md" },
                    { type: "text", text: "พิมพ์เลขคิวของท่านได้เลย", margin: "md", size: "sm", color: "#555555" },
                    { type: "text", text: "ตัวอย่าง: 4012", size: "xs", color: "#aaaaaa", margin: "xs" }
                ]
            },
            footer: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                contents: [
                    {
                        type: "button",
                        action: { type: "message", label: "📋 ดูรายการล่าสุด", text: "ล่าสุด" },
                        style: "secondary"
                    },
                    {
                        type: "button",
                        action: { type: "uri", label: "🌐 ดูคิวสด (Web)", uri: "https://queue-monitor.vercel.app" },
                        style: "primary", color: "#1DB446"
                    }
                ]
            }
        }
    });
}

// =======================================================
// 🛠️ HELPER FUNCTIONS
// =======================================================

async function isQuotaFull() {
    try {
        const [quota, consumption] = await Promise.all([
            client.getMessageQuota(), client.getMessageQuotaConsumption()
        ]);
        return (quota.type !== 'none' && consumption.totalUsage >= quota.value);
    } catch (e) { return false; }
}

async function getSmartQueueStatus(targetQueue) {
    try {
        const seriesStart = Math.floor(targetQueue / 1000) * 1000;
        const seriesEnd = seriesStart + 1000;
        const { data: snapshots } = await supabase
            .from('queue_snapshots') 
            .select('current_queue, current_counter')
            .order('created_at', { ascending: false })
            .limit(50);

        if (snapshots && snapshots.length > 0) {
            const match = snapshots.find(item => {
                const q = parseInt(item.current_queue);
                return q >= seriesStart && q < seriesEnd;
            });
            if (match) return { queue: parseInt(match.current_queue), counter: match.current_counter || '-' };
        }
    } catch (e) { console.error("Fetch Status Error:", e); }
    return { queue: 0, counter: '-' };
}

// =======================================================
// 🎨 FLEX GENERATORS
// =======================================================

function generateStatusFlex(targetQueue, status) {
    const { queue: currentQueue, counter: currentCounter } = status;
    
    // ตั้งค่าลิ้งก์ Deep Link เข้า Telegram พร้อมเลขคิว
    const telegramDeepLink = `https://t.me/NakhonsawanLandBot?start=${targetQueue}`;

    let statusText = "สถานะคิว";
    let statusColor = "#999999"; 
    let descText = "ตรวจสอบข้อมูล...";
    
    if (currentQueue > 0) {
        const diff = targetQueue - currentQueue;
        
        if (diff === 0) {
            statusText = "ถึงคิวแล้ว!";
            statusColor = "#D93025"; 
            descText = `กรุณาติดต่อช่อง ${currentCounter}`;
        } else if (diff === 1) {
            statusText = "คิวถัดไป";
            statusColor = "#F9AB00"; 
            descText = "เตรียมตัวรอเรียกได้เลย";
        } else if (diff > 1) {
            statusText = `รออีก ${diff} คิว`;
            statusColor = "#1DB446"; 
            descText = `คิวปัจจุบัน: ${currentQueue}`;
        } else if (diff < 0) {
            statusText = "คิวปัจจุบัน";
            statusColor = "#555555"; 
            descText = `ขณะนี้เรียกถึงคิว: ${currentQueue}`;
        }
    } else {
        descText = "ยังไม่มีข้อมูลการเรียกคิวหมวดนี้";
    }

    return {
        type: "flex",
        altText: `สถานะคิว ${targetQueue}`,
        contents: {
            type: "bubble",
            size: "kilo",
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "บัตรคิวของคุณ", weight: "bold", color: "#aaaaaa", size: "xs" },
                    { type: "text", text: `${targetQueue}`, weight: "bold", size: "4xl", margin: "md", color: "#333333" },
                    { type: "separator", margin: "lg" },
                    {
                        type: "box",
                        layout: "vertical",
                        margin: "lg",
                        contents: [
                            { type: "text", text: statusText, weight: "bold", size: "xl", color: statusColor, align: "center" },
                            { type: "text", text: descText, size: "sm", color: "#555555", align: "center", margin: "sm" }
                        ]
                    }
                ]
            },
            footer: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                contents: [
                    {
                        type: "button",
                        action: { type: "uri", label: "🔔 แจ้งเตือนผ่าน Telegram", uri: telegramDeepLink },
                        style: "primary", height: "sm", color: "#2481cc"
                    },
                    {
                        type: "button",
                        action: { type: "message", label: "📋 ดูรายการล่าสุด", text: "ล่าสุด" },
                        style: "secondary", height: "sm"
                    }
                ]
            }
        }
    };
}

function generateHistoryFlex(logs) {
    const listItems = logs.map(log => {
        // แก้ไข TimeZone ให้เป็นเวลาไทย
        const time = new Date(log.created_at).toLocaleTimeString('th-TH', { 
            timeZone: 'Asia/Bangkok', 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        return {
            type: "box",
            layout: "horizontal",
            contents: [
                { type: "text", text: `${time}`, size: "sm", color: "#888888", flex: 2 },
                { type: "text", text: `คิว ${log.current_queue}`, size: "sm", color: "#333333", weight: "bold", flex: 3 },
                { type: "text", text: `ช่อง ${log.current_counter}`, size: "sm", color: "#1DB446", align: "end", flex: 2 }
            ],
            margin: "sm"
        };
    });

    return {
        type: "flex",
        altText: "รายการเรียกคิวล่าสุด",
        contents: {
            type: "bubble",
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "📋 รายการเรียกคิวล่าสุด", weight: "bold", size: "md", color: "#1DB446" },
                    { type: "separator", margin: "md" },
                    {
                        type: "box",
                        layout: "vertical",
                        margin: "md",
                        contents: listItems
                    }
                ]
            },
            footer: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "กด 'ล่าสุด' เพื่ออัปเดตข้อมูล", size: "xs", color: "#aaaaaa", align: "center" }
                ]
            }
        }
    };
}
