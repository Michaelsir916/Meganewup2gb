const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String },
  firstName: { type: String },
  joinedAt: { type: Date, default: Date.now },
  totalDownloads: { type: Number, default: 0 },
  totalBytesDownloaded: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now }
});

const fileLogSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  fileId: { type: String },
  fileName: { type: String },
  fileSize: { type: Number },
  fileType: { type: String },
  megaUrl: { type: String },
  downloadedAt: { type: Date, default: Date.now },
  success: { type: Boolean, default: true },
  errorMsg: { type: String }
});

const activeTaskSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  fileName: { type: String },
  megaUrl: { type: String },
  localPath: { type: String },
  status: { type: String, default: 'processing' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const FileLog = mongoose.model('FileLog', fileLogSchema);
const ActiveTask = mongoose.model('ActiveTask', activeTaskSchema);

async function connectDB() {
  try {
    if (!process.env.MONGO_URI) {
      console.log('⚠️ MONGO_URI not found in .env. Skipping database connection.');
      return false;
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB successfully!');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    return false;
  }
}

module.exports = {
  User,
  FileLog,
  ActiveTask,
  connectDB
};
