const aircode = require('aircode');

module.exports = async function(params, context) {
  const contentsTable = aircode.db.table('contents');
  const allRecords = await contentsTable.where().find();
  return { allRecords };
};
