/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const exists = await knex.schema.hasColumn('wingas', 'sms_enabled');
  if (!exists) {
    await knex.schema.alterTable('wingas', (table) => {
      table.boolean('sms_enabled').notNullable().defaultTo(false);
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  const exists = await knex.schema.hasColumn('wingas', 'sms_enabled');
  if (exists) {
    await knex.schema.alterTable('wingas', (table) => {
      table.dropColumn('sms_enabled');
    });
  }
};