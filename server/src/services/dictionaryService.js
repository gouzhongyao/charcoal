const { openDatabase } = require('../db/database');

function listEnergyTypes() {
  const db = openDatabase();
  try {
    return db.prepare(
      `SELECT
         id,
         code,
         name,
         category,
         default_unit AS defaultUnit,
         standard_unit AS standardUnit,
         carbon_factor_required AS carbonFactorRequired,
         is_active AS isActive,
         display_order AS displayOrder
       FROM energy_types
       WHERE is_active = 1
       ORDER BY display_order ASC, code ASC`
    ).all();
  } finally {
    db.close();
  }
}

module.exports = {
  listEnergyTypes
};
