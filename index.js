const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

mongoose.connect('mongodb://localhost:27017/service_chat')
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

// Схемы данных
const Settings = mongoose.model('Settings', new mongoose.Schema({ allScriptsEnabled: { type: Boolean, default: true } }));
const Step = mongoose.model('Step', new mongoose.Schema({ 
    key: String, title: String, question: String, options: Array, scriptsActive: { type: Boolean, default: true }, order: { type: Number, default: 0 } 
}));
const Gallery = mongoose.model('Gallery', new mongoose.Schema({ title: String, img: String, desc: String }));
const Message = mongoose.model('Message', new mongoose.Schema({ 
    chatId: String, sender: String, text: String, file: Object, fileComment: String, options: Array, timestamp: { type: Date, default: Date.now } 
}));
const Chat = mongoose.model('Chat', new mongoose.Schema({ 
    chatId: String, customNote: { type: String, default: "" }, currentStep: { type: String, default: 'start' }, lastUpdate: { type: Date, default: Date.now } 
}));

// Функция для полной рассылки данных менеджеру
const broadcastManagerUpdate = async () => {
    const steps = await Step.find().sort({ order: 1 });
    const gallery = await Gallery.find();
    const chats = await Chat.find().sort({ lastUpdate: -1 });
    const messages = await Message.find().sort({ timestamp: 1 });
    let settings = await Settings.findOne() || await Settings.create({ allScriptsEnabled: true });
    
    const fullChats = chats.map(c => ({
        ...c._doc,
        messages: messages.filter(m => m.chatId === c.chatId)
    }));

    io.emit('steps_list_ordered', steps);
    io.emit('gallery_data', gallery);
    io.emit('update_chat_list', fullChats);
    io.emit('global_settings', settings);
};

io.on('connection', (socket) => {
  socket.on('manager_init', async () => {
    await broadcastManagerUpdate();
  });

  socket.on('client_init', async (chatId) => {
    socket.join(chatId);
    let chat = await Chat.findOne({ chatId });
    if (!chat) {
        chat = await Chat.create({ chatId });
        const startStep = await Step.findOne({ key: 'start', scriptsActive: true });
        if (startStep) {
            const m = await Message.create({ chatId, sender: 'bot', text: startStep.question, options: startStep.options });
            io.to(chatId).emit('receive_message', m);
        }
    }
    socket.emit('history', await Message.find({ chatId }).sort({ timestamp: 1 }));
    socket.emit('gallery_data', await Gallery.find());
    await broadcastManagerUpdate();
  });

  socket.on('send_message', async (data) => {
    const { chatId, sender, text, file, fileComment, nextStep } = data;
    const msg = await Message.create({ chatId, sender, text, file, fileComment, timestamp: new Date() });
    io.to(chatId).emit('receive_message', msg);
    await Chat.findOneAndUpdate({ chatId }, { lastUpdate: Date.now() });

    // Автоматика
    const settings = await Settings.findOne();
    if (settings?.allScriptsEnabled && (nextStep || sender === 'user')) {
        let stepToTrigger = null;
        if (nextStep) {
            stepToTrigger = await Step.findOne({ key: nextStep, scriptsActive: true });
        }
        
        if (stepToTrigger) {
            setTimeout(async () => {
                const botMsg = await Message.create({ 
                    chatId, sender: 'bot', text: stepToTrigger.question, options: stepToTrigger.options 
                });
                io.to(chatId).emit('receive_message', botMsg);
                await Chat.findOneAndUpdate({ chatId }, { currentStep: stepToTrigger.key });
                await broadcastManagerUpdate();
            }, 800);
        }
    }
    await broadcastManagerUpdate();
  });

  socket.on('send_manual_script', async ({ chatId, stepKey }) => {
    const step = await Step.findOne({ key: stepKey });
    if (step) {
        const botMsg = await Message.create({ chatId, sender: 'bot', text: step.question, options: step.options });
        io.to(chatId).emit('receive_message', botMsg);
        await Chat.findOneAndUpdate({ chatId }, { currentStep: stepKey, lastUpdate: Date.now() });
        await broadcastManagerUpdate();
    }
  });

  socket.on('save_step', async (step) => {
    await Step.findOneAndUpdate({ key: step.key }, step, { upsert: true });
    await broadcastManagerUpdate();
  });

  socket.on('delete_step', async (key) => {
    await Step.deleteOne({ key });
    await broadcastManagerUpdate();
  });

  socket.on('toggle_all_scripts', async (val) => {
    await Settings.findOneAndUpdate({}, { allScriptsEnabled: val }, { upsert: true });
    await broadcastManagerUpdate();
  });

  socket.on('update_chat_note', async ({ chatId, note }) => {
    await Chat.findOneAndUpdate({ chatId }, { customNote: note });
    await broadcastManagerUpdate();
  });

  socket.on('delete_message', async ({ msgId, chatId }) => {
    await Message.findByIdAndDelete(msgId);
    io.to(chatId).emit('message_deleted', msgId);
    await broadcastManagerUpdate();
  });

  socket.on('delete_chat', async (chatId) => {
    await Chat.deleteOne({ chatId });
    await Message.deleteMany({ chatId });
    await broadcastManagerUpdate();
  });

  socket.on('save_gallery_item', async (data) => {
    await new Gallery(data).save();
    await broadcastManagerUpdate();
  });

  socket.on('delete_gallery_item', async (id) => {
    await Gallery.findByIdAndDelete(id);
    await broadcastManagerUpdate();
  });

  socket.on('update_steps_order', async (orderedSteps) => {
    for (let i = 0; i < orderedSteps.length; i++) {
        await Step.findByIdAndUpdate(orderedSteps[i]._id, { order: i });
    }
    await broadcastManagerUpdate();
  });
});

server.listen(4000, () => console.log("Server running on port 4000"));