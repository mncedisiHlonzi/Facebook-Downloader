const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const routes = require('./routes');
const path = require('path'); // Add this
const videoRoutes = require('./routes/videoRoutes');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Serve static files from temp directory
app.use('/temp', express.static(path.join(__dirname, 'temp')));

app.use('/api', routes);
app.use('/', videoRoutes);

// Railway needs to bind to 0.0.0.0
app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running at http://0.0.0.0:${port}`);
});