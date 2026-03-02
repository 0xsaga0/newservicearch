// auth-service/server.js
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const Redis = require('ioredis');
const app = express();

const redis = new Redis({
    host: 'localhost',
    port: 6379,
    retryStrategy: (times) => {
        // Экспоненциальная задержка при переподключении
        return Math.min(times * 50, 2000);
    }
});

// Обработка ошибок Redis
redis.on('error', (err) => {
    console.error('Redis connection error:', err);
});

// Хеширование пароля с солью
const hashPassword = async (password) => {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
};

// Генерация JWT токенов
const generateTokens = (userId, role) => {
    const accessToken = jwt.sign(
        { userId, role, type: 'access' },
        process.env.JWT_SECRET || 'your-secret-key',
        { expiresIn: '1h' }
    );
    
    const refreshToken = jwt.sign(
        { userId, type: 'refresh' },
        process.env.JWT_REFRESH_SECRET || 'your-refresh-secret',
        { expiresIn: '7d' }
    );
    
    return { accessToken, refreshToken };
};

// Регистрация пользователя с обработкой ошибок
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    
    try {
        // Валидация
        if (!username || !email || !password) {
            return res.status(400).json({
                code: 400,
                message: 'Missing required fields',
                details: ['username', 'email', 'password']
            });
        }
        
        if (password.length < 6) {
            return res.status(400).json({
                code: 400,
                message: 'Password must be at least 6 characters'
            });
        }
        
        // Проверка существования пользователя в Redis
        const existingUser = await redis.get(`user:email:${email}`);
        if (existingUser) {
            return res.status(409).json({
                code: 409,
                message: 'User already exists'
            });
        }
        
        // Хеширование пароля
        const hashedPassword = await hashPassword(password);
        
        // Создание пользователя
        const userId = await redis.incr('user:count');
        const user = {
            id: userId,
            username,
            email,
            password: hashedPassword,
            role: 'user',
            createdAt: new Date().toISOString(),
            isActive: true
        };
        
        // Сохранение в Redis
        await redis.set(`user:${userId}`, JSON.stringify(user));
        await redis.set(`user:email:${email}`, userId);
        
        // Генерация токенов
        const tokens = generateTokens(userId, user.role);
        
        // Сохранение refresh token в Redis
        await redis.setex(
            `refresh:${tokens.refreshToken}`,
            7 * 24 * 60 * 60, // 7 дней
            userId
        );
        
        res.status(201).json({
            message: 'User registered successfully',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role
            },
            tokens
        });
        
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            code: 500,
            message: 'Internal server error',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Логин с rate limiting
const loginAttempts = new Map();

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const ip = req.ip;
    
    try {
        // Rate limiting
        const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: Date.now() };
        
        if (attempts.count >= 5 && Date.now() - attempts.lastAttempt < 15 * 60 * 1000) {
            return res.status(429).json({
                code: 429,
                message: 'Too many login attempts. Try again later.'
            });
        }
        
        // Поиск пользователя
        const userId = await redis.get(`user:email:${email}`);
        if (!userId) {
            // Увеличиваем счетчик неудачных попыток
            loginAttempts.set(ip, {
                count: attempts.count + 1,
                lastAttempt: Date.now()
            });
            
            return res.status(401).json({
                code: 401,
                message: 'Invalid credentials'
            });
        }
        
        const userJson = await redis.get(`user:${userId}`);
        const user = JSON.parse(userJson);
        
        // Проверка пароля
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            loginAttempts.set(ip, {
                count: attempts.count + 1,
                lastAttempt: Date.now()
            });
            
            return res.status(401).json({
                code: 401,
                message: 'Invalid credentials'
            });
        }
        
        // Сброс счетчика при успешном входе
        loginAttempts.delete(ip);
        
        // Обновление времени последнего входа
        user.lastLogin = new Date().toISOString();
        await redis.set(`user:${userId}`, JSON.stringify(user));
        
        // Генерация токенов
        const tokens = generateTokens(user.id, user.role);
        
        // Сохранение refresh token
        await redis.setex(
            `refresh:${tokens.refreshToken}`,
            7 * 24 * 60 * 60,
            user.id
        );
        
        res.json({
            message: 'Login successful',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role
            },
            tokens
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            code: 500,
            message: 'Internal server error'
        });
    }
});

// Внутренний endpoint для проверки токена (для других сервисов)
app.get('/api/internal/verify/:token', async (req, res) => {
    const { token } = req.params;
    
    try {
        // Проверка JWT
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        
        // Проверка существования пользователя
        const userJson = await redis.get(`user:${decoded.userId}`);
        if (!userJson) {
            return res.status(404).json({
                valid: false,
                error: 'User not found'
            });
        }
        
        const user = JSON.parse(userJson);
        
        res.json({
            valid: true,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });
        
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            res.status(401).json({
                valid: false,
                error: 'Token expired'
            });
        } else {
            res.status(401).json({
                valid: false,
                error: 'Invalid token'
            });
        }
    }
});