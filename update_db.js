const db = require('./db');

async function runMigration() {
  try {
    const hasColumn = await db.schema.hasColumn('wingas', 'location');
    if (!hasColumn) {
      await db.schema.table('wingas', function (table) {
        table.string('location', 255).defaultTo('Tanzania');
      });
      console.log('✅ Column ya location imeongezwa kwa mafanikio kwenye table ya wingas!');
    } else {
      console.log('ℹ️ Column ya location ipo tayari kwenye database.');
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ Hitilafu wakati wa kuongeza column:', err);
    process.exit(1);
  }
}

runMigration();