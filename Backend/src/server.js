const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const routes = require('./routes');
const sequelize = require('./config/database');
const User = require('./models/user');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use('/api', routes);

const videoRoutes = require('./routes/videoRoutes');
app.use('/', videoRoutes);

// Sync sequelize models
sequelize.sync().then(() => {
    console.log('Database & tables created!');
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running at http://0.0.0.0:${port}`);
});