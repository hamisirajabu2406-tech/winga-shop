require('dotenv').config();

const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'winga_shop',
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false }
  },
  pool: { min: 2, max: 10 }
});

async function initDb() {
  try {
    if (!await knex.schema.hasTable('wingas')) {
      await knex.schema.createTable('wingas', (table) => {
        table.increments('id').primary();
        table.string('name').notNullable();
        table.string('phone', 50).unique().notNullable();
        table.string('password').notNullable();
        table.string('status', 50).defaultTo('active');
        table.timestamp('expiryDate').nullable();
        table.timestamp('dateAdded').defaultTo(knex.fn.now());
      });
    }

    if (!await knex.schema.hasTable('products')) {
      await knex.schema.createTable('products', (table) => {
        table.increments('id').primary();
        table.integer('wingaId').unsigned().notNullable();
        table.string('name').notNullable();
        table.string('category', 100).defaultTo('General');
        table.decimal('buyingPrice', 10, 2).defaultTo(0);
        table.decimal('sellingPrice', 10, 2).notNullable();
        table.decimal('price', 10, 2).notNullable();
        table.string('size', 50).defaultTo('Standard');
        table.text('imageUrl');
        table.text('imageLocalPath');
        table.timestamp('dateAdded').defaultTo(knex.fn.now());
        table.foreign('wingaId').references('wingas.id').onDelete('CASCADE');
      });
    }

    if (!await knex.schema.hasTable('orders')) {
      await knex.schema.createTable('orders', (table) => {
        table.increments('id').primary();
        table.integer('orderId').notNullable();
        table.integer('wingaId').unsigned().notNullable();
        table.string('productName').notNullable();
        table.decimal('buyingPrice', 10, 2).defaultTo(0);
        table.decimal('sellingPrice', 10, 2).notNullable();
        table.string('customerPhone', 50).notNullable();
        table.string('location').defaultTo('Haikutajwa');
        table.string('senderJid').nullable();
        table.string('status', 50).defaultTo('Pending');
        table.timestamp('date').defaultTo(knex.fn.now());
        table.foreign('wingaId').references('wingas.id').onDelete('CASCADE');
      });
    }

    if (!await knex.schema.hasTable('reviews')) {
      await knex.schema.createTable('reviews', (table) => {
        table.increments('id').primary();
        table.integer('orderId').notNullable().unique();
        table.integer('rating').notNullable();
        table.text('comment');
        table.timestamp('date').defaultTo(knex.fn.now());
      });
    }

    if (!await knex.schema.hasTable('stats')) {
      await knex.schema.createTable('stats', (table) => {
        table.string('key', 50).primary();
        table.integer('value').defaultTo(0);
      });
      await knex('stats').insert({ key: 'catalogVisits', value: 0 }).onConflict('key').ignore();
    }

    if (!await knex.schema.hasTable('password_resets')) {
      await knex.schema.createTable('password_resets', (table) => {
        table.increments('id').primary();
        table.string('phone', 50).notNullable();
        table.string('otp', 6).notNullable();
        table.timestamp('expiresAt').notNullable();
        table.timestamp('createdAt').defaultTo(knex.fn.now());
      });
    }

    console.log('✅ Database initialized successfully.');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}

knex.raw('SELECT 1').then(() => initDb());

module.exports = knex;