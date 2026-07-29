const express = require('express');
const cors = require('cors');
const { initDatabase } = require('./db/database');
const systemRoutes = require('./routes/system');
const dictionaryRoutes = require('./routes/dictionaries');
const energyTypeRoutes = require('./routes/energyTypes');
const importRoutes = require('./routes/imports');
const energyRecordRoutes = require('./routes/energyRecords');
const dashboardRoutes = require('./routes/dashboard');
const carbonRoutes = require('./routes/carbon');
const predictionRoutes = require('./routes/predictions');
const templateRoutes = require('./routes/templates');
const backupRoutes = require('./routes/backups');
const organizationRoutes = require('./routes/organization');
const meterRoutes = require('./routes/meters');
const meterReadingRoutes = require('./routes/meterReadings');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();
const port = Number(process.env.PORT || 3002);
const defaultAllowedOrigins = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:7777',
  'http://localhost:7777'
];

function parseAllowedOrigin(origin) {
  const rawOrigin = String(origin || '').trim();
  if (!rawOrigin) {
    return '';
  }
  try {
    const parsedOrigin = new URL(rawOrigin);
    const hostname = parsedOrigin.hostname.toLowerCase();
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    if (!['http:', 'https:'].includes(parsedOrigin.protocol) || !isLocalHost) {
      return '';
    }
    return parsedOrigin.origin;
  } catch (error) {
    return '';
  }
}

const envAllowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(parseAllowedOrigin)
  .filter(Boolean);
const allowedOrigins = new Set([...defaultAllowedOrigins, ...envAllowedOrigins]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS origin is not allowed'));
  },
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'X-Recommended-Format', 'X-Backup-Name']
}));
app.use(express.json({ limit: '2mb' }));

app.use('/api', systemRoutes);
app.use('/api/dictionaries', dictionaryRoutes);
app.use('/api/energy-types', energyTypeRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/energy-records', energyRecordRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/carbon', carbonRoutes);
app.use('/api/predictions', predictionRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/system/backups', backupRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/meters', meterRoutes);
app.use('/api/meter-readings', meterReadingRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

function start() {
  initDatabase();
  app.listen(port, '127.0.0.1', () => {
    console.log(`Energy carbon platform API listening at http://127.0.0.1:${port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
