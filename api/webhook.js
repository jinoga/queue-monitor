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
// 🚀 MAIN HANDLER (Vercel)
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
// 🎮 EVENT ROUTER (ตัวแยกแยะคำสั่ง)
// =======================================================
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;

    const userId = event.source.userId;
    const text = event.message.text.trim();

    const isNumberOnly = /^\d+$/.test(text);
    const isTrackCommand = text.startsWith('ติดตามคิว');

    console.log(`User: ${userId} sent: ${text}`);

    if (isNumberOnly || isTrackCommand) {
        return await processQueueTracking(event, userId, text, isNumberOnly);
    } else if (text === 'หยุด' || text === 'ยกเลิก') {
        return await processStopTracking(event, userId);
    } else if (text === 'ล่าสุด' || text === 'ประวัติ' || text === 'สถานะ') {
        return await processViewHistory(event);
    } else if (text === 'คู่มือ' || text === 'เมนู' || text === 'help') {
        return await sendWelcomeMenu(event);
    } else {
        return await sendWelcomeMenu(event);
    }
}

// =======================================================
// 🧠 BUSINESS LOGIC
// =======================================================

// 🔹 1. เริ่มติดตามคิว
async function processQueueTracking(event, userId, text, isNumberOnly) {
    let queueInput = isNumberOnly ? text : text.replace('ติดตามคิว', '').trim();
    if (!queueInput || isNaN(queueInput)) {
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ กรุณาระบุเลขคิวให้ถูกต้อง เช่น '4012'" });
    }
    const targetQueue = parseInt(queueInput);

    const { error } = await supabase.from('line_trackers').upsert({ 
        user_id: userId, 
        tracking_queue: targetQueue 
    });

    if (error) {
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ ระบบขัดข้อง กรุณาลองใหม่" });
    }

    return await processViewHistory(event, targetQueue); 
}

// 🔹 2. ดูประวัติ (ดึง 10 รายการย้อนหลัง)
async function processViewHistory(event, knownQueue = null) {
    const userId = event.source.userId;

    try {
        let myQueue = knownQueue;

        if (!myQueue) {
            const { data: tracker } = await supabase
                .from('line_trackers')
                .select('tracking_queue')
                .eq('user_id', userId)
                .maybeSingle();

            if (!tracker) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: "❌ ท่านยังไม่ได้ติดตามคิว\nกรุณาพิมพ์เลขคิวของท่านก่อน (เช่น 4012)"
                });
            }
            myQueue = parseInt(tracker.tracking_queue);
        }

        // ✅ แยก range ตามหลัก: หลักหมื่น (>=10000) ใช้ groupSize 10000, หลักพัน ใช้ 1000
        const groupSize = myQueue >= 10000 ? 10000 : 1000;
        const seriesStart = Math.floor(myQueue / groupSize) * groupSize;
        const seriesEnd = seriesStart + groupSize;

        // ✅ ดึงข้อมูลแบบ broad แล้วกรองใน JS เพื่อป้องกันปัญหา string comparison ใน DB
        const { data: allLogs } = await supabase
            .from('queue_snapshots')
            .select('current_queue, current_counter, created_at')
            .order('created_at', { ascending: false })
            .limit(200);

        const logs = (allLogs || [])
            .filter(log => {
                const q = parseInt(log.current_queue);
                return q >= seriesStart && q < seriesEnd;
            })
            .slice(0, 10);

        if (!logs || logs.length === 0) {
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: `⏳ ยังไม่มีการเรียกคิวในหมวด ${seriesStart} วันนี้` 
            });
        }

        const flexMessage = generateHistoryFlex(myQueue, logs);
        return client.replyMessage(event.replyToken, flexMessage);

    } catch (e) {
        console.error("History Error:", e);
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ เกิดข้อผิดพลาดในการดึงข้อมูล" });
    }
}

// 🔹 3. ยกเลิก
async function processStopTracking(event, userId) {
    await supabase.from('line_trackers').delete().eq('user_id', userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: '❌ ยกเลิกการติดตามเรียบร้อยแล้ว' });
}

// 🔹 4. เมนูหลัก
async function sendWelcomeMenu(event) {
    try {
        const flexMessage = {
            type: 'flex',
            altText: 'คู่มือการใช้งานระบบจองคิว',
            contents: {
                type: "bubble",
                body: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        { type: "text", text: "วิธีการใช้งาน", weight: "bold", size: "xl", color: "#1DB446", align: "center" },
                        { type: "text", text: "ระบบติดตามคิวที่ดิน จ.นครสวรรค์", weight: "bold", size: "xs", color: "#aaaaaa", align: "center", margin: "xs" },
                        { type: "separator", margin: "md" },
                        {
                            type: "box", layout: "horizontal", margin: "md",
                            contents: [
                                { type: "text", text: "1️⃣", size: "md", flex: 1 },
                                {
                                    type: "box", layout: "vertical", flex: 9,
                                    contents: [
                                        { type: "text", text: "พิมพ์เลขคิว", weight: "bold", size: "sm", color: "#333333" },
                                        { type: "text", text: "เช่น 4012 แล้วกดส่ง", size: "xs", color: "#888888", wrap: true }
                                    ]
                                }
                            ]
                        },
                        {
                            type: "box", layout: "horizontal", margin: "md",
                            contents: [
                                { type: "text", text: "2️⃣", size: "md", flex: 1 },
                                {
                                    type: "box", layout: "vertical", flex: 9,
                                    contents: [
                                        { type: "text", text: "รอรับการแจ้งเตือน", weight: "bold", size: "sm", color: "#333333" },
                                        { type: "text", text: "เมื่อคิวขยับ ระบบจะแจ้งทันที", size: "xs", color: "#888888", wrap: true }
                                    ]
                                }
                            ]
                        },
                        {
                            type: "box", layout: "horizontal", margin: "md",
                            contents: [
                                { type: "text", text: "3️⃣", size: "md", flex: 1 },
                                {
                                    type: "box", layout: "vertical", flex: 9,
                                    contents: [
                                        { type: "text", text: "เช็คสถานะล่าสุด", weight: "bold", size: "sm", color: "#333333" },
                                        { type: "text", text: "กดปุ่มด้านล่างได้ตลอดเวลา", size: "xs", color: "#888888", wrap: true }
                                    ]
                                }
                            ]
                        }
                    ]
                },
                footer: {
                    type: "box",
                    layout: "vertical",
                    spacing: "sm",
                    contents: [
                        { type: "separator" },
                        {
                            type: "button",
                            style: "primary",
                            color: "#1DB446",
                            height: "sm",
                            margin: "md",
                            action: { type: "message", label: "📋 เช็คคิวล่าสุด", text: "ล่าสุด" }
                        },
                        {
                            type: "button",
                            style: "secondary",
                            height: "sm",
                            action: { type: "uri", label: "🌐 ดูผ่านเว็บไซต์", uri: "https://queue-monitor.vercel.app" }
                        }
                    ]
                }
            }
        };

        return await client.replyMessage(event.replyToken, flexMessage);

    } catch (err) {
        console.error("Menu Error:", err);
    }
}

// =======================================================
// 🎨 FLEX MESSAGE GENERATOR
// =======================================================

function generateHistoryFlex(myQueue, logs) {
    const latestQueue = parseInt(logs[0].current_queue);
    const diff = myQueue - latestQueue;
    const telegramDeepLink = `https://t.me/NakhonsawanLandBot?start=${myQueue}`; 

    let headerTitle = "", headerColor = "#000000", subTitle = "";

    if (diff > 0) {
        headerTitle = `รออีก ${diff} คิว`;
        headerColor = "#1DB446";
        subTitle = `คิวล่าสุด: ${latestQueue}`;
    } else if (diff === 0) {
        headerTitle = "ถึงคิวแล้ว!";
        headerColor = "#D93025";
        subTitle = `เชิญช่อง: ${logs[0].current_counter}`;
    } else {
        headerTitle = "เลยคิวแล้ว";
        headerColor = "#555555";
        subTitle = `คิวล่าสุดไปที่: ${latestQueue}`;
    }

    const listItems = logs.map(log => {
        const time = new Date(log.created_at).toLocaleTimeString('th-TH', { 
            timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' 
        });
        
        const isLatest = (parseInt(log.current_queue) === latestQueue);
        
        return {
            type: "box",
            layout: "horizontal",
            contents: [
                { type: "text", text: `${time}`, size: "sm", color: isLatest ? "#333333" : "#888888", flex: 2 },
                { type: "text", text: `คิว ${log.current_queue}`, size: "sm", color: "#333333", weight: isLatest ? "bold" : "regular", flex: 3 },
                { type: "text", text: `ช่อง ${log.current_counter}`, size: "sm", color: isLatest ? "#D93025" : "#1DB446", align: "end", flex: 2, weight: isLatest ? "bold" : "regular" }
            ],
            margin: "sm",
            backgroundColor: isLatest ? "#f0fdf4" : "#ffffff",
            paddingAll: isLatest ? "sm" : "none",
            cornerRadius: isLatest ? "md" : "none"
        };
    });

    return {
        type: "flex",
        altText: `เหลืออีก ${diff} คิว`,
        contents: {
            type: "bubble",
            header: {
                type: "box",
                layout: "vertical",
                backgroundColor: "#f7f7f7",
                contents: [
                    { type: "text", text: "คิวของคุณ", size: "xs", color: "#aaaaaa", align: "center" },
                    { type: "text", text: `${myQueue}`, size: "xxl", weight: "bold", color: "#333333", align: "center" },
                    { type: "separator", margin: "md" },
                    { type: "text", text: headerTitle, size: "xl", weight: "bold", color: headerColor, align: "center", margin: "md" },
                    { type: "text", text: subTitle, size: "sm", color: "#555555", align: "center", margin: "sm" }
                ]
            },
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "ประวัติการเรียก (หมวดนี้)", weight: "bold", size: "sm", color: "#aaaaaa", margin: "md" },
                    { type: "separator", margin: "sm" },
                    { type: "box", layout: "vertical", margin: "md", contents: listItems }
                ]
            },
            footer: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                contents: [
                    {
                        type: "button",
                        style: "secondary",
                        height: "sm",
                        action: { type: "message", label: "🔄 อัปเดตสถานะคิวของท่าน", text: "ล่าสุด" }
                    },
                    {
                        type: "button",
                        style: "primary",
                        height: "sm",
                        color: "#2481cc",
                        action: { type: "uri", label: "🔔 รับการแจ้งเตือนผ่าน Telegram (สำรอง)", uri: telegramDeepLink }
                    },
                    {
                        type: "button",
                        style: "secondary",
                        height: "sm",
                        action: { type: "message", label: "📖 คู่มือการใช้งาน", text: "คู่มือ" }
                    },
                    {
                        type: "button",
                        style: "link",
                        height: "sm",
                        action: { type: "uri", label: "🌐 ติดตามคิวผ่านเว็บไซต์", uri: "https://queue-monitor.vercel.app" }
                    }
                ]
            }
        }
    };
}
