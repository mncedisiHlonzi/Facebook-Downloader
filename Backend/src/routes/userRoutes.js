const express = require('express');
const router = express.Router();
const User = require('../models/user');

// Define routes here
router.get('/', async (req, res) => {
    const users = await User.findAll();
    res.json(users);
});

router.post('/user', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.create({ username, password });
    res.json(user);
});

module.exports = router;