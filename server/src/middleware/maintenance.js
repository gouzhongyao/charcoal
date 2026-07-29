const { assertWritableAllowed } = require('../services/maintenanceState');

function requireWritable(action) {
  return (req, res, next) => {
    try {
      assertWritableAllowed(action || `${req.method} ${req.originalUrl}`);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  requireWritable
};
