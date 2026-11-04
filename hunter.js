import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';

// --- КОНФИГУРАЦИЯ ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const ADMIN_WA_NUMBER = process.env.ADMIN_WA_NUMBER; 

if (!SUPABASE_URL || !SUPABASE_KEY || !ADMIN_WA_NUMBER) {
  console.error("❌ ОШИБКА: Не заданы переменные окружения (SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_WA_NUMBER)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const GROUPS = {
  cargo: '',
  evacuator: '',
  manipulator: '',
  plumber: '',
  cleaning: '',
  welder: '',
  electrician: '',
  fridge: '',
  washer: '',
  tv: '',
  hour: ''
};

// --- ВЕБ-СЕРВЕР ДЛЯ RENDER ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('🦅 Hunter is running!'));
app.listen(PORT, () => console.log(`🌐 Веб-сервер запущен на порту ${PORT}`));

// --- ИНИЦИАЛИЗАЦИЯ WHATSAPP ---
let sock;
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('🔄 Переподключение...');
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp подключен!');
      const groups = await sock.groupFetchAllParticipating();
      console.log("📋 СПИСОК ВАШИХ ГРУПП (Скопируйте ID в код):");
      Object.values(groups).forEach(g => {
         console.log(`Группа: "${g.subject}" | JID: ${g.id}`);
      });
    }
  });

  sock.ev.on('messages.upsert', async m => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderJid = msg.key.remoteJid;
    const senderPhone = senderJid.split('@')[0]; 

    if (senderJid.endsWith('@g.us') && text.toLowerCase().includes('беру')) {
      await handleTakeOrder(senderJid, senderPhone);
    }

    if (senderJid === `${ADMIN_WA_NUMBER}@s.whatsapp.net` && text.toLowerCase() === 'да') {
      await publishPendingOrders();
    }
  });
}

// --- ЛОГИКА ХИЩНИКА ---
async function processContour(contourName) {
  try {
    const oneMinuteAgo = new Date(Date.now() - 60000).toISOString();

    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .eq('hunter', contourName)
      .eq('status', 'NEW')
      .is('assigned_executor_id', null)
      .lt('created_at', oneMinuteAgo);

    if (!orders || orders.length === 0) return;

    for (const order of orders) {
      const { data: logs } = await supabase
        .from('audit_log')
        .select('id')
        .eq('order_id', order.id)
        .eq('action', 'hunter_posted')
        .limit(1);

      if (logs && logs.length > 0) continue; 

      const textToAdmin = `🦅 [${contourName}] Заказ #${order.id.slice(0, 5)}\n` +
                          `Услуга: ${order.service_id} (${order.variant_id})\n` +
                          `Адрес: ${order.address}\n\n` +
                          `Опубликовать в группу? Напиши "да"`;

      await sock.sendMessage(`${ADMIN_WA_NUMBER}@s.whatsapp.net`, { text: textToAdmin });
      
      await supabase.from('audit_log').insert({
        actor: 'HUNTER_03', action: 'admin_asked', order_id: order.id,
        details: { contour: contourName, text: textToAdmin }
      });
    }
  } catch (err) {
    console.error(`Ошибка в контуре ${contourName}:`, err.message);
  }
}

async function publishPendingOrders() {
  const { data: logs } = await supabase
    .from('audit_log')
    .select('order_id')
    .eq('action', 'admin_asked')
    .order('created_at', { ascending: false })
    .limit(1);

  if (!logs || logs.length === 0) return;
  const orderId = logs[0].order_id;

  const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
  if (!order) return;

  const groupJid = GROUPS[order.service_id];
  if (!groupJid) {
    await sock.sendMessage(`${ADMIN_WA_NUMBER}@s.whatsapp.net`, { text: `❌ Ошибка: ID группы для ${order.service_id} не указан в коде.` });
    return;
  }

  const postText = `🚨 ЗАКАЗ #${order.id.slice(0, 5)} · ${order.service_id.toUpperCase()}\n` +
                   `📍 ${order.address}\n` +
                   `🚗 ${order.variant_id || 'Уточнить'}\n\n` +
                   `Кто берёт — напишите «беру» или «+»\n` +
                   `Телефон клиента пришлю в ЛС.`;

  await sock.sendMessage(groupJid, { text: postText });

  await supabase.from('audit_log').insert({
    actor: 'HUNTER_03', action: 'hunter_posted', order_id: order.id,
    details: { group: order.service_id, text: postText }
  });

  await supabase.from('audit_log').delete().eq('action', 'admin_asked').eq('order_id', order.id);
  await sock.sendMessage(`${ADMIN_WA_NUMBER}@s.whatsapp.net`, { text: `✅ Заказ #${order.id.slice(0, 5)} опубликован.` });
}

async function handleTakeOrder(groupJid, senderPhone) {
  const serviceId = Object.keys(GROUPS).find(key => GROUPS[key] === groupJid);
  if (!serviceId) return;

  const { data: postedLogs } = await supabase
    .from('audit_log')
    .select('order_id')
    .eq('action', 'hunter_posted')
    .eq('details->>group', serviceId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (!postedLogs || postedLogs.length === 0) return;
  const orderId = postedLogs[0].order_id;

  const formattedPhone = `+${senderPhone}`; 
  const { data: executors } = await supabase
    .from('executors')
    .select('*')
    .eq('phone', formattedPhone)
    .eq('service_id', serviceId)
    .eq('is_approved', true);

  if (!executors || executors.length === 0) {
    await sock.sendMessage(groupJid, { text: `@${senderPhone} ❌ Вас нет в базе для этой услуги.` });
    return;
  }

  const executor = executors[0];

  const { data: updatedOrder, error } = await supabase
    .from('orders')
    .update({ assigned_executor_id: executor.id, status: 'TAKEN' })
    .eq('id', orderId)
    .is('assigned_executor_id', null) 
    .select()
    .single();

  if (error || !updatedOrder) {
    await sock.sendMessage(groupJid, { text: `@${senderPhone} ❌ Заказ уже забрал кто-то другой.` });
    return;
  }

  const dmText = `✅ Заказ #${updatedOrder.id.slice(0, 5)} ваш!\n📍 ${updatedOrder.address}\n📞 Клиент: ${updatedOrder.client_phone}`;
  
  await sock.sendMessage(`${senderPhone}@s.whatsapp.net`, { text: dmText });
  await sock.sendMessage(groupJid, { text: `🔒 Заказ #${updatedOrder.id.slice(0, 5)} забран. Спасибо!` });

  await supabase.from('audit_log').insert({
    actor: `EXECUTOR_${executor.id}`, action: 'order_taken', order_id: orderId,
    details: { executor_phone: executor.phone, vehicle: executor.vehicle_number }
  });
}

// --- ЗАПУСК ---
async function start() {
  await connectToWhatsApp();
  setInterval(() => processContour('HUNTER_01'), 15000);
  setInterval(() => processContour('HUNTER_02'), 15000);
}

start();
