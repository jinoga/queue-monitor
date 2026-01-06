const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = new line.Client(config);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const events = req.body.events;
    try {
        await Promise.all(events.map(event => handleEvent(event)));
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).end();
    }
}

async function handleEvent(event) {
    // รับเฉพาะข้อความที่เป็น Text
    if (event.type !== 'message' || event.message.type !== 'text') return null;

    const userId = event.source.userId;
    const text = event.message.text.trim();

    // 1. คำสั่ง "ติดตามคิว [เลขคิว]"
    if (text.startsWith('ติดตามคิว')) {
        const queueInput = text.replace('ติดตามคิว', '').trim();
        
        // ตรวจสอบว่าเป็นตัวเลขหรือไม่
        if (!queueInput || isNaN(queueInput)) {
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: "❌ กรุณาระบุหมายเลขคิวเป็นตัวเลข เช่น 'ติดตามคิว 100'"
            });
        }

        const targetQueue = parseInt(queueInput);

        try {
            // บันทึกลง Supabase (ใช้ upsert เพื่อให้ 1 userId ติดตามได้ 1 คิวล่าสุด)
            const { error } = await supabase
                .from('line_trackers')
                .upsert({ 
                    user_id: userId, 
                    tracking_queue: targetQueue 
                });

            if (error) throw error;

            // ตอบกลับยืนยันการติดตาม
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: `✅ เริ่มติดตามคิว ${targetQueue} ให้คุณแล้ว\n\n` +
                      `🔔 ระบบจะแจ้งเตือน 2 ครั้ง:\n` +
                      `1️⃣ เมื่อถึงคิวที่ ${targetQueue - 1} (แจ้งเตือนล่วงหน้าพร้อมสถิติ)\n` +
                      `2️⃣ เมื่อถึงคิวที่ ${targetQueue} (แจ้งเตือนให้รับบริการ)\n\n` +
                      `💡 ติดตามสด/ไม่จำกัด: https://t.me/NakhonsawanLandBot\n` +
                      `🌐 เว็บไซต์: https://queue-monitor.vercel.app`
            });
        } catch (dbError) {
            console.error("Supabase Error:", dbError);
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: "❌ เกิดข้อผิดพลาดในระบบฐานข้อมูล กรุณาลองใหม่"
            });
        }
    }

    // 2. คำสั่ง "หยุด"
    if (text === 'หยุด') {
        await supabase.from('line_trackers').delete().eq('user_id', userId);
        return client.replyMessage(event.replyToken, { 
            type: 'text', 
            text: '❌ ยกเลิกการติดตามคิวทั้งหมดเรียบร้อยแล้ว' 
        });
    }

    // 3. ข้อความอื่นๆ (เมนูแนะนำ)
    return client.replyMessage(event.replyToken, {
        type: 'text',
        text: "🤖 ระบบติดตามคิวที่ดิน จ.นครสวรรค์\n\n" +
              "🔹 พิมพ์ 'ติดตามคิว (ตามด้วยเลขคิวของท่าน)' เพื่อรับแจ้งเตือนเมื่อใกล้ถึงคิว เช่น ติดตามคิว 1001\n" +
              "🔹 พิมพ์ 'หยุด' เพื่อยกเลิกการติดตาม\n" +
              "🔹 ติดตามสด/ไม่จำกัด: https://t.me/NakhonsawanLandBot\n" +
              "🔹 เว็บไซต์: https://queue-monitor.vercel.app"
      
    });
}
