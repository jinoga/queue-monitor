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
        
        // --- ส่วนที่ 1: เช็คโควต้าก่อนดำเนินการ (เหมือนเดิม) ---
        try {
            const [quota, consumption] = await Promise.all([
                client.getMessageQuota(),             
                client.getMessageQuotaConsumption()   
            ]);

            if (quota.type !== 'none' && consumption.totalUsage >= quota.value) {
                console.warn(`Line Quota Reached: Used ${consumption.totalUsage}/${quota.value}`);
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `⚠️ ขณะนี้โควต้าการแจ้งเตือนผ่าน LINE เต็มแล้ว (Limit Reached)\n\n` +
                          `ระบบจะไม่สามารถส่งแจ้งเตือนเมื่อถึงคิวได้ในขณะนี้\n` +
                          `กรุณาใช้ช่องทางสำรอง ฟรีและไม่มีลิมิต:\n\n` +
                          `👉 Telegram Bot: https://t.me/NakhonsawanLandBot\n` +
                          `🌐 เว็บไซต์: https://queue-monitor.vercel.app`
                });
            }
        } catch (quotaError) {
            console.error("Error checking quota:", quotaError);
        }
        // ----------------------------------------

        const queueInput = text.replace('ติดตามคิว', '').trim();
        
        // ตรวจสอบว่าเป็นตัวเลขหรือไม่
        if (!queueInput || isNaN(queueInput)) {
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: "❌ กรุณาระบุหมายเลขคิวเป็นตัวเลข เช่น 'ติดตามคิว 100'"
            });
        }

        const targetQueue = parseInt(queueInput);

        // --- ส่วนที่ 2 (เพิ่มใหม่): ดึงคิวปัจจุบันมาเทียบเพื่อแจ้งเตือนทันที ---
        let currentQueue = 0;
        try {
            // ⚠️ แก้ตรงนี้: ใส่ชื่อ Table ที่เก็บ logs หรือสถานะคิวล่าสุดของคุณ
            // เช่น .from('queue_logs') หรือ .from('current_state')
            const { data: statusData } = await supabase
                .from('queue_logs') // <--- แก้ชื่อตารางนี้ให้ตรงกับ DB ของคุณ
                .select('queue_number') // <--- แก้ชื่อคอลัมน์ที่เก็บเลขคิวล่าสุด
                .order('created_at', { ascending: false }) // เอาตัวล่าสุด
                .limit(1)
                .single();
            
            if (statusData) {
                currentQueue = statusData.queue_number; // <--- แก้ชื่อ field ให้ตรง
            }
        } catch (e) {
            console.error("Failed to fetch current queue:", e);
        }
        // ----------------------------------------

        try {
            // บันทึกลง Supabase (ใช้ upsert เพื่อให้ 1 userId ติดตามได้ 1 คิวล่าสุด)
            const { error } = await supabase
                .from('line_trackers')
                .upsert({ 
                    user_id: userId, 
                    tracking_queue: targetQueue 
                });

            if (error) throw error;

            // --- ส่วนที่ 3 (ปรับปรุง): สร้างข้อความตอบกลับแบบ Dynamic ---
            let replyText = `✅ เริ่มติดตามคิว ${targetQueue} ให้คุณแล้ว`;

            if (currentQueue > 0) {
                replyText += `\n(ขณะนี้คิวที่: ${currentQueue})`;

                // เช็คเงื่อนไขทันที
                if (currentQueue >= targetQueue) {
                    // ถึงแล้ว หรือ เลยแล้ว
                    replyText += `\n\n🚨 **ถึงคิวของท่านแล้ว!** (หรือเลยคิวแล้ว)\nกรุณาติดต่อเคาน์เตอร์บริการทันที`;
                } else if (targetQueue - currentQueue === 1) {
                    // เหลืออีก 1 คิว (คือคิวถัดไป)
                    replyText += `\n\n⚠️ **เตรียมตัว! ท่านคือคิวถัดไป**\nกรุณารอเรียกที่หน้าช่องบริการ`;
                } else {
                    // ยังอีกนาน
                    replyText += `\n\n🔔 ระบบจะแจ้งเตือนเมื่อใกล้ถึงคิวครับ`;
                }
            } else {
                // กรณีดึงค่าคิวปัจจุบันไม่ได้ (ใช้ข้อความมาตรฐานเดิม)
                replyText += `\n\n🔔 ระบบจะแจ้งเตือน 2 ครั้ง:\n` +
                             `1️⃣ เมื่อถึงคิวที่ ${targetQueue - 1} (แจ้งเตือนล่วงหน้า)\n` +
                             `2️⃣ เมื่อถึงคิวที่ ${targetQueue} (แจ้งเตือนให้รับบริการ)`;
            }

            // Footer
            replyText += `\n\n💡 ติดตามสด: https://t.me/NakhonsawanLandBot\n` +
                         `🌐 เว็บไซต์: https://queue-monitor.vercel.app`;

            // ตอบกลับ
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: replyText
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
