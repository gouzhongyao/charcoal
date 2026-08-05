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
const productionRoutes = require('./routes/production');
const generationRoutes = require('./routes/generation');
const energyBudgetRoutes = require('./routes/energyBudgets');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const roleRoutes = require('./routes/roles');
const menuRoutes = require('./routes/menus');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();
const port = Number(process.env.PORT || 3002);
const defaultAllowedOrigins = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://[::1]:5173',
  'http://127.0.0.1:7777',
  'http://localhost:7777',
  'http://[::1]:7777'
];

function parseAllowedOrigin(origin) {
  const rawOrigin = String(origin || '').trim();
  if (!rawOrigin || rawOrigin.includes('*')) {
    return '';
  }
  try {
    const parsedOrigin = new URL(rawOrigin);
    if (!['http:', 'https:'].includes(parsedOrigin.protocol)) {
      return '';
    }
    if (!parsedOrigin.hostname || parsedOrigin.username || parsedOrigin.password) {
      return '';
    }
    if (parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) {
      return '';
    }
    if (parsedOrigin.origin === 'null') {
      return '';
    }
    return parsedOrigin.origin;
  } catch (error) {
    return '';
  }
}

function buildAllowedOrigins(corsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS || '') {
  const envAllowedOrigins = String(corsAllowedOrigins)
    .split(',')
    .map(parseAllowedOrigin)
    .filter(Boolean);
  return new Set([...defaultAllowedOrigins, ...envAllowedOrigins]);
}

function isCorsOriginAllowed(origin, allowedOriginsSet = allowedOrigins) {
  return !origin || allowedOriginsSet.has(origin);
}

const allowedOrigins = buildAllowedOrigins();

app.use(cors({
  origin(origin, callback) {
    if (isCorsOriginAllowed(origin)) {
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
app.use('/api/production', productionRoutes);
app.use('/api/generation', generationRoutes);
app.use('/api/energy-budgets', energyBudgetRoutes);
app.use('/api', authRoutes);
app.use('/api/system/users', userRoutes);
app.use('/api/system/roles', roleRoutes);
app.use('/api/system/menus', menuRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/menus', menuRoutes);

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

module.exports = {
  app,
  start,
  defaultAllowedOrigins,
  parseAllowedOrigin,
  buildAllowedOrigins,
  isCorsOriginAllowed
};
