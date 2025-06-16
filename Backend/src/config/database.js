const { Sequelize } = require('sequelize');

const sequelize = new Sequelize('fb_downloader_db', 'postgres', 'tycoon1st', {
    host: 'localhost',
    dialect: 'postgres',
    logging: console.log,
});

module.exports = sequelize;