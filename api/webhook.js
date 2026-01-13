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

    // 1. สั่งติดตามคิว
    if (isNumberOnly || isTrackCommand) {
        return await processQueueTracking(event, userId, text, isNumberOnly);
    } 
    // 2. สั่งยกเลิก
    else if (text === 'หยุด') {
        return await processStopTracking(event, userId);
    } 
    // 3. ดูประวัติล่าสุด
    else if (text === 'ล่าสุด' || text === 'ประวัติ') {
        return await processViewHistory(event);
    } 
    // 4. พิมพ์อย่างอื่น -> ส่งเมนูคู่มือ (แบบไม่มีรูป) ✅
    else {
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

    // บันทึกลง DB
    const { error } = await supabase.from('line_trackers').upsert({ 
        user_id: userId, 
        tracking_queue: targetQueue 
    });

    if (error) {
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ ระบบขัดข้อง กรุณาลองใหม่" });
    }

    // เมื่อเริ่มติดตาม ให้แสดงหน้า "ประวัติ/สถานะ" ทันที เพื่อความสวยงาม
    return await processViewHistory(event, targetQueue); 
}

// 🔹 2. ดูประวัติ (ดึง 10 รายการย้อนหลัง)
async function processViewHistory(event, knownQueue = null) {
    const userId = event.source.userId;

    try {
        let myQueue = knownQueue;

        // ถ้าไม่รู้เลขคิว (กรณีพิมพ์ "ล่าสุด" เข้ามาเอง) ให้ไปหาใน DB
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

        // คำนวณหมวดหมู่ (เช่น 4xxx)
        const seriesStart = Math.floor(myQueue / 1000) * 1000;
        const seriesEnd = seriesStart + 1000;

        // ดึง 10 รายการล่าสุด
        const { data: logs } = await supabase
            .from('queue_snapshots')
            .select('current_queue, current_counter, created_at')
            .gte('current_queue', seriesStart) 
            .lt('current_queue', seriesEnd)    
            .order('created_at', { ascending: false })
            .limit(10);

        if (!logs || logs.length === 0) {
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: `⏳ ยังไม่มีการเรียกคิวในหมวด ${seriesStart} วันนี้` 
            });
        }

        // สร้าง Flex Message แบบตารางรายการ
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
    return client.replyMessage(event.replyToken, {
        type: 'flex',
        altText: 'คู่มือการใช้งาน',
        contents: {
            type: "bubble",
            // ❌ ตัดส่วน hero (รูปภาพ) ออกแล้ว กัน Error
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "วิธีการใช้งาน", weight: "bold", size: "xl", color: "#1DB446", align: "center" },
                    { type: "text", text: "ระบบติดตามคิวที่ดิน จ.นครสวรรค์", weight: "bold", size: "xs", color: "#aaaaaa", align: "center", margin: "xs" },
                    { type: "separator", margin: "md" },
                    
                    // ข้อ 1
                    {
                        type: "box", layout: "horizontal", margin: "md",
                        contents: [
                            { type: "text", text: "1️⃣", size: "md", flex: 1 },
                            {
                                type: "box", layout: "vertical", flex: 9,
                                contents: [
                                    { type: "text", text: "พิมพ์เลขคิว", weight: "bold", size: "sm", color: "#333333" },
                                    { type: "text", text: "เช่น 4012 แล้วกดส่ง", size: "xs", color: "#888888" }
                                ]
                            }
                        ]
                    },
                    
                    // ข้อ 2
                    {
                        type: "box", layout: "horizontal", margin: "md",
                        contents: [
                            { type: "text", text: "2️⃣", size: "md", flex: 1 },
                            {
                                type: "box", layout: "vertical", flex: 9,
                                contents: [
                                    { type: "text", text: "รอรับการแจ้งเตือน", weight: "bold", size: "sm", color: "#333333" },
                                    { type: "text", text: "เมื่อคิวขยับ ระบบจะแจ้งทันที", size: "xs", color: "#888888" }
                                ]
                            }
                        ]
                    },

                    // ข้อ 3
                    {
                        type: "box", layout: "horizontal", margin: "md",
                        contents: [
                            { type: "text", text: "3️⃣", size: "md", flex: 1 },
                            {
                                type: "box", layout: "vertical", flex: 9,
                                contents: [
                                    { type: "text", text: "เช็คสถานะล่าสุด", weight: "bold", size: "sm", color: "#333333" },
                                    { type: "text", text: "กดปุ่มด้านล่างได้ตลอดเวลา", size: "xs", color: "#888888" }
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
                    { type: "spacer", size: "md" },
                    {
                        type: "button",
                        style: "primary",
                        color: "#1DB446",
                        height: "sm",
                        action: { type: "message", label: "📋 เช็คคิวล่าสุด", text: "ล่าสุด" }
                    },
                    {
                        type: "button",
                        style: "secondary",
                        height: "sm",
                        action: { type: "uri", label: "🌐 ติดตามคิวผ่านเว็บไซต์", uri: "https://queue-monitor.vercel.app" }
                    }
                ]
            }
        }
    });
}

// =======================================================
// 🎨 FLEX MESSAGE GENERATOR
// =======================================================

function generateHistoryFlex(myQueue, logs) {
    // คำนวณคิวที่เหลือ (เทียบกับรายการล่าสุดอันบนสุด)
    const latestQueue = parseInt(logs[0].current_queue);
    const diff = myQueue - latestQueue;
    const telegramDeepLink = `https://t.me/NakhonsawanLandBot?start=${myQueue}`; // แก้ชื่อบอทให้ตรง

    let headerTitle = "", headerColor = "#000000", subTitle = "";

    if (diff > 0) {
        headerTitle = `รออีก ${diff} คิว`;
        headerColor = "#1DB446"; // เขียว
        subTitle = `คิวล่าสุด: ${latestQueue}`;
    } else if (diff === 0) {
        headerTitle = "ถึงคิวแล้ว!";
        headerColor = "#D93025"; // แดง
        subTitle = `เชิญช่อง: ${logs[0].current_counter}`;
    } else {
        headerTitle = "เลยคิวแล้ว";
        headerColor = "#555555"; // เทา
        subTitle = `คิวล่าสุดไปที่: ${latestQueue}`;
    }

    // สร้างลิสต์ 10 รายการ
    const listItems = logs.map(log => {
        const time = new Date(log.created_at).toLocaleTimeString('th-TH', { 
            timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' 
        });
        
        const isLatest = (log.current_queue === latestQueue);
        
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
            // ส่วน Header: สรุปสถานะ
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
            // ส่วน Body: ตารางรายการ
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "ประวัติการเรียก (หมวดนี้)", weight: "bold", size: "sm", color: "#aaaaaa", margin: "md" },
                    { type: "separator", margin: "sm" },
                    { type: "box", layout: "vertical", margin: "md", contents: listItems }
                ]
            },
            // ส่วน Footer: 3 ปุ่มกด
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
                        style: "link",
                        height: "sm",
                        action: { type: "uri", label: "🌐 ติดตามคิวผ่านเว็บไซต์", uri: "https://queue-monitor.vercel.app" }
                    }
                ]
            }
        }
    };
}




