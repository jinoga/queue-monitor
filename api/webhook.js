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

    // 1. สั่งติดตามคิว (เช่น "4012")
    if (isNumberOnly || isTrackCommand) {
        return await processQueueTracking(event, userId, text, isNumberOnly);
    } 
    // 2. สั่งยกเลิก
    else if (text === 'หยุด') {
        return await processStopTracking(event, userId);
    } 
    // 3. กดปุ่ม "ล่าสุด" หรือพิมพ์ "ล่าสุด"
    else if (text === 'ล่าสุด' || text === 'สถานะ' || text === 'ประวัติ') {
        return await processCheckLatestStatus(event, userId);
    } 
    // 4. อื่นๆ -> ส่งเมนู
    else {
        return await sendWelcomeMenu(event);
    }
}

// =======================================================
// 🧠 BUSINESS LOGIC
// =======================================================

// 🔹 ฟังก์ชัน 1: เริ่มติดตามคิว
async function processQueueTracking(event, userId, text, isNumberOnly) {
    let queueInput = isNumberOnly ? text : text.replace('ติดตามคิว', '').trim();
    if (!queueInput || isNaN(queueInput)) {
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ กรุณาระบุเลขคิวให้ถูกต้อง เช่น '4012'" });
    }
    const targetQueue = parseInt(queueInput);

    // 1. ดึงสถานะปัจจุบัน
    const status = await getSmartQueueStatus(targetQueue);

    // 2. บันทึกลง DB
    const { error } = await supabase.from('line_trackers').upsert({ 
        user_id: userId, 
        tracking_queue: targetQueue 
    });

    if (error) {
        console.error("DB Error:", error);
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ ระบบขัดข้อง ชั่วคราว" });
    }

    // 3. สร้าง Flex Message สวยๆ
    const flexMessage = generateStatusFlex(targetQueue, status);
    return client.replyMessage(event.replyToken, flexMessage);
}

// 🔹 ฟังก์ชัน 2: กดปุ่ม "ล่าสุด" เพื่อเช็คสถานะ
async function processCheckLatestStatus(event, userId) {
    // 1. ไปดูใน DB ว่าคนนี้ติดตามคิวอะไรอยู่
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

    const targetQueue = parseInt(tracker.tracking_queue);

    // 2. ดึงสถานะปัจจุบันของคิวนั้น
    const status = await getSmartQueueStatus(targetQueue);

    // 3. สร้าง Flex Message ตอบกลับ (หน้าตาเหมือนตอนเริ่มติดตาม แต่ข้อมูลอัปเดต)
    const flexMessage = generateStatusFlex(targetQueue, status);
    return client.replyMessage(event.replyToken, flexMessage);
}

// 🔹 ฟังก์ชัน 3: ยกเลิก
async function processStopTracking(event, userId) {
    await supabase.from('line_trackers').delete().eq('user_id', userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: '❌ ยกเลิกการติดตามเรียบร้อยแล้ว' });
}

// 🔹 ฟังก์ชัน 4: เมนูหลัก
async function sendWelcomeMenu(event) {
    // ส่ง Flex Message แนะนำตัวง่ายๆ
    return client.replyMessage(event.replyToken, {
        type: 'flex',
        altText: 'เมนูหลัก',
        contents: {
            type: "bubble",
            body: {
                type: "box", layout: "vertical",
                contents: [
                    { type: "text", text: "ระบบติดตามคิวที่ดิน", weight: "bold", size: "xl", color: "#1DB446" },
                    { type: "text", text: "พิมพ์เลขคิวเพื่อเริ่มติดตาม", size: "sm", color: "#555555" }
                ]
            }
        }
    });
}

// =======================================================
// 🛠️ HELPER FUNCTIONS (ตัวช่วยดึงข้อมูล)
// =======================================================

async function getSmartQueueStatus(targetQueue) {
    try {
        const seriesStart = Math.floor(targetQueue / 1000) * 1000;
        const seriesEnd = seriesStart + 1000;
        
        // ดึงข้อมูลล่าสุดจาก Snapshot ที่ Worker (บน VPS) เป็นคนบันทึกไว้
        const { data: snapshots } = await supabase
            .from('queue_snapshots') 
            .select('current_queue, current_counter')
            .gte('current_queue', seriesStart)
            .lt('current_queue', seriesEnd)
            .order('created_at', { ascending: false })
            .limit(1);

        if (snapshots && snapshots.length > 0) {
            return { 
                currentQueue: parseInt(snapshots[0].current_queue), 
                counter: snapshots[0].current_counter 
            };
        }
    } catch (e) { console.error("Fetch Status Error:", e); }
    return { currentQueue: 0, counter: '-' };
}

// =======================================================
// 🎨 FLEX MESSAGE GENERATOR (พระเอกของเรา)
// =======================================================

function generateStatusFlex(targetQueue, status) {
    const { currentQueue, counter } = status;
    const telegramDeepLink = `https://t.me/NakhonsawanLandBot?start=${targetQueue}`; // แก้ลิ้งก์บอทของคุณให้ตรง

    let statusText = "รอเรียกคิว";
    let statusColor = "#1DB446"; // เขียว
    let descText = "ยังไม่มีข้อมูลในระบบ";
    
    if (currentQueue > 0) {
        const diff = targetQueue - currentQueue;
        
        if (diff === 0) {
            statusText = "ถึงคิวแล้ว!";
            statusColor = "#D93025"; // แดง
            descText = `เชิญที่ช่องบริการ ${counter}`;
        } else if (diff === 1) {
            statusText = "คิวถัดไป";
            statusColor = "#F9AB00"; // ส้ม
            descText = "เตรียมตัวรอเรียกได้เลย";
        } else if (diff > 1) {
            statusText = `รออีก ${diff} คิว`;
            statusColor = "#1DB446"; // เขียว
            descText = `คิวปัจจุบัน: ${currentQueue}`;
        } else if (diff < 0) {
            statusText = "เลยคิวแล้ว";
            statusColor = "#555555"; // เทา
            descText = `คิวไปที่ ${currentQueue} แล้ว`;
        }
    }

    return {
        type: "flex",
        altText: `สถานะคิว ${targetQueue}: ${statusText}`,
        contents: {
            type: "bubble",
            size: "kilo",
            header: {
                type: "box",
                layout: "vertical",
                backgroundColor: statusColor,
                contents: [
                    { type: "text", text: "สถานะคิวของคุณ", color: "#ffffff", size: "xs", align: "center" },
                    { type: "text", text: statusText, color: "#ffffff", weight: "bold", size: "xxl", align: "center", margin: "sm" }
                ]
            },
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    // แสดงเลขคิวของคุณ
                    { type: "text", text: "บัตรคิวของคุณ", color: "#aaaaaa", size: "xs", align: "center" },
                    { type: "text", text: `${targetQueue}`, weight: "bold", size: "4xl", color: "#333333", align: "center" },
                    
                    { type: "separator", margin: "lg" },
                    
                    // แสดงรายละเอียด
                    { type: "text", text: descText, size: "md", color: "#555555", align: "center", margin: "lg", wrap: true }
                ]
            },
            footer: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                contents: [
                    // ปุ่มที่ 1: อัปเดตสถานะ (ส่งข้อความ "ล่าสุด" กลับมา)
                    {
                        type: "button",
                        style: "secondary",
                        height: "sm",
                        action: { type: "message", label: "🔄 อัปเดตสถานะ", text: "ล่าสุด" }
                    },
                    // ปุ่มที่ 2: ไป Telegram (ทางเลือก)
                    {
                        type: "button",
                        style: "link",
                        height: "sm",
                        action: { type: "uri", label: "🔔 แจ้งเตือนผ่าน Telegram", uri: telegramDeepLink }
                    }
                ]
            }
        }
    };
}
