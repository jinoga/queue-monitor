const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

// =======================================================
// ⚙️ CONFIGURATION & CLIENTS
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
// 🎮 EVENT CONTROLLER
// =======================================================
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;

    const userId = event.source.userId;
    const text = event.message.text.trim();

    // เช็คว่าเป็นตัวเลขล้วน หรือ คำสั่งติดตาม
    const isNumberOnly = /^\d+$/.test(text);
    const isCommand = text.startsWith('ติดตามคิว');

    if (isNumberOnly || isCommand) {
        await processQueueTracking(event, userId, text, isNumberOnly);
    } else if (text === 'หยุด') {
        await processStopTracking(event, userId);
    } else {
        await sendWelcomeMenu(event);
    }
}

// =======================================================
// 🧠 BUSINESS LOGIC
// =======================================================

async function processQueueTracking(event, userId, text, isNumberOnly) {
    // 1. Check Quota
    const isQuotaFull = await checkQuotaLimit();
    if (isQuotaFull) {
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⚠️ ขณะนี้โควต้า LINE เต็มแล้ว กรุณาใช้ Telegram: https://t.me/NakhonsawanLandBot`
        });
    }

    // 2. Parse Input
    let queueInput = isNumberOnly ? text : text.replace('ติดตามคิว', '').trim();
    if (!queueInput || isNaN(queueInput)) {
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: "❌ กรุณาระบุเลขคิวให้ถูกต้อง เช่น '4012'"
        });
    }
    const targetQueue = parseInt(queueInput);

    // 3. Get Status (Smart Filter)
    const status = await getSmartQueueStatus(targetQueue);

    // 4. Save to DB
    const { error } = await supabase.from('line_trackers').upsert({ 
        user_id: userId, 
        tracking_queue: targetQueue 
    });

    if (error) {
        console.error("DB Error:", error);
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ ระบบขัดข้อง กรุณาลองใหม่" });
    }

    // 5. Send Flex Message
    const flexMessage = generateFlexMessage(targetQueue, status);
    return client.replyMessage(event.replyToken, flexMessage);
}

async function processStopTracking(event, userId) {
    await supabase.from('line_trackers').delete().eq('user_id', userId);
    return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '❌ ยกเลิกการติดตามเรียบร้อยแล้ว' 
    });
}

async function sendWelcomeMenu(event) {
    // ใช้ Flex Message สำหรับเมนูหลักให้น่าใช้
    return client.replyMessage(event.replyToken, {
        type: 'flex',
        altText: 'เมนูติดตามคิวที่ดิน',
        contents: {
            type: "bubble",
            hero: {
                type: "image",
                url: "https://cdn-icons-png.flaticon.com/512/3135/3135715.png", // Icon คิว (ตัวอย่าง)
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
                contents: [
                    {
                        type: "button",
                        action: { type: "uri", label: "ดูคิวสด (Web)", uri: "https://queue-monitor.vercel.app" },
                        style: "primary", color: "#1DB446"
                    },
                    {
                        type: "button",
                        action: { type: "uri", label: "Telegram Bot", uri: "https://t.me/NakhonsawanLandBot" },
                        margin: "sm"
                    }
                ]
            }
        }
    });
}

// =======================================================
// 🛠️ HELPER FUNCTIONS & FLEX GENERATOR
// =======================================================

async function checkQuotaLimit() {
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
    } catch (e) { console.error("Fetch Error:", e); }
    return { queue: 0, counter: '-' };
}

/**
 * สร้าง Flex Message สวยงามตามสถานะ
 */
function generateFlexMessage(targetQueue, status) {
    const { queue: currentQueue, counter: currentCounter } = status;
    
    // Default Color & Text (กรณีรอคิว)
    let statusText = "รอเรียกคิว";
    let statusColor = "#1DB446"; // Green
    let descText = "ระบบกำลังติดตามให้คุณ...";
    
    if (currentQueue > 0) {
        const diff = targetQueue - currentQueue;
        
        if (diff === 0) {
            statusText = "ถึงคิวแล้ว!";
            statusColor = "#D93025"; // Red
            descText = `กรุณาติดต่อช่อง ${currentCounter}`;
        } else if (diff === 1) {
            statusText = "คิวถัดไป";
            statusColor = "#F9AB00"; // Yellow/Orange
            descText = "เตรียมตัวรอเรียกได้เลย";
        } else if (diff > 1) {
            statusText = `รออีก ${diff} คิว`;
            statusColor = "#1DB446"; // Green
            descText = `คิวปัจจุบัน: ${currentQueue}`;
        } else if (diff < 0) {
            // เลยคิว (ไม่แจ้งเตือนรุนแรง ตามที่ขอ) แสดงแค่สถานะ
            statusText = "เรียกผ่านไปแล้ว";
            statusColor = "#999999"; // Grey
            descText = `คิวปัจจุบัน: ${currentQueue}`;
        }
    } else {
        // ยังไม่มีข้อมูลคิวหมวดนี้
        descText = "รอระบบอัปเดตข้อมูล...";
    }

    return {
        type: "flex",
        altText: `ติดตามคิว ${targetQueue}: ${statusText}`,
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
                        style: "primary",
                        height: "sm",
                        color: "#1DB446",
                        action: { type: "uri", label: "ดูคิวสด (Website)", uri: "https://queue-monitor.vercel.app" }
                    },
                    {
                        type: "button",
                        style: "link",
                        height: "sm",
                        action: { type: "uri", label: "Telegram Bot", uri: "https://t.me/NakhonsawanLandBot" }
                    }
                ]
            }
        }
    };
}
