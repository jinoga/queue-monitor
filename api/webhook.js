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
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const userId = event.source.userId;
  const text = event.message.text.trim();

  // 1. คำสั่งติดตามคิว
  if (text.startsWith('ติดตามคิว')) {
    const q = text.replace('ติดตามคิว', '').trim();
    
    // บันทึกลง Supabase
    await supabase.from('line_trackers').upsert({ user_id: userId, tracking_queue: q });

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ ระบบเริ่มติดตามคิว ${q} ให้คุณแล้ว\n\n⚠️ หมายเหตุ: LINE จำกัดการแจ้งเตือน 200 ครั้ง/เดือน\n💡 แนะนำให้ติดตามผ่าน Telegram (ไม่จำกัด) ที่: https://t.me/NakhonsawanLandBot และเว็บไซต์ : https://queue-monitor.vercel.app`
    });
  }

  // 2. คำสั่งหยุด
  if (text === 'หยุด') {
    await supabase.from('line_trackers').delete().eq('user_id', userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: '❌ หยุดติดตามแล้ว' });
  }

  // 3. เมนูแนะนำ
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: "🤖 ยินดีต้อนรับสู่ระบบติดตามคิวที่ดิน จ.นครสวรรค์\n\n🔹 พิมพ์ 'ติดตามคิว 100' เพื่อรับแจ้งเตือนเมื่อใกล้ถึงคิว 100\n🔹 พิมพ์ 'หยุด' เพื่อยกเลิก\n🔹 ดูคิวสดผ่านเว็บ: https://queue-monitor.vercel.app"
  });

}
