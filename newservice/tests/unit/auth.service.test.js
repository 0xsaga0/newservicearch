// tests/unit/auth.service.test.js
const request = require('supertest');
const assert = require('assert');
const app = require('../../auth-service/server');
const Redis = require('ioredis-mock');

// Мок Redis
jest.mock('ioredis', () => require('ioredis-mock'));

describe('Auth Service Unit Tests', () => {
    
    describe('POST /api/auth/register', () => {
        it('should register new user successfully', async () => {
            const response = await request(app)
                .post('/api/auth/register')
                .send({
                    username: 'testuser',
                    email: 'test@example.com',
                    password: 'password123'
                });
            
            assert.strictEqual(response.statusCode, 201);
            assert.ok(response.body.user.id);
            assert.ok(response.body.tokens.accessToken);
            assert.ok(response.body.tokens.refreshToken);
            assert.strictEqual(response.body.user.email, 'test@example.com');
        });
        
        it('should return 400 for missing fields', async () => {
            const response = await request(app)
                .post('/api/auth/register')
                .send({
                    username: 'testuser'
                });
            
            assert.strictEqual(response.statusCode, 400);
            assert.ok(response.body.details.includes('email'));
            assert.ok(response.body.details.includes('password'));
        });
        
        it('should return 400 for short password', async () => {
            const response = await request(app)
                .post('/api/auth/register')
                .send({
                    username: 'testuser',
                    email: 'test@example.com',
                    password: '123'
                });
            
            assert.strictEqual(response.statusCode, 400);
            assert.ok(response.body.message.includes('6 characters'));
        });
    });
    
    describe('POST /api/auth/login', () => {
        beforeEach(async () => {
            // Создаем тестового пользователя
            await request(app)
                .post('/api/auth/register')
                .send({
                    username: 'logintest',
                    email: 'login@example.com',
                    password: 'password123'
                });
        });
        
        it('should login successfully with correct credentials', async () => {
            const response = await request(app)
                .post('/api/auth/login')
                .send({
                    email: 'login@example.com',
                    password: 'password123'
                });
            
            assert.strictEqual(response.statusCode, 200);
            assert.ok(response.body.tokens.accessToken);
            assert.strictEqual(response.body.user.email, 'login@example.com');
        });
        
        it('should return 401 for wrong password', async () => {
            const response = await request(app)
                .post('/api/auth/login')
                .send({
                    email: 'login@example.com',
                    password: 'wrongpassword'
                });
            
            assert.strictEqual(response.statusCode, 401);
            assert.strictEqual(response.body.message, 'Invalid credentials');
        });
        
        it('should return 429 after too many failed attempts', async () => {
            // 5 неудачных попыток
            for (let i = 0; i < 5; i++) {
                await request(app)
                    .post('/api/auth/login')
                    .send({
                        email: 'login@example.com',
                        password: 'wrong'
                    });
            }
            
            // 6-я попытка
            const response = await request(app)
                .post('/api/auth/login')
                .send({
                    email: 'login@example.com',
                    password: 'wrong'
                });
            
            assert.strictEqual(response.statusCode, 429);
            assert.ok(response.body.message.includes('Too many login attempts'));
        });
    });
    
    describe('GET /api/internal/verify/:token', () => {
        let validToken;
        
        beforeEach(async () => {
            const regResponse = await request(app)
                .post('/api/auth/register')
                .send({
                    username: 'verifytest',
                    email: 'verify@example.com',
                    password: 'password123'
                });
            
            validToken = regResponse.body.tokens.accessToken;
        });
        
        it('should verify valid token', async () => {
            const response = await request(app)
                .get(`/api/internal/verify/${validToken}`);
            
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.valid, true);
            assert.ok(response.body.user);
            assert.strictEqual(response.body.user.email, 'verify@example.com');
        });
        
        it('should reject invalid token', async () => {
            const response = await request(app)
                .get('/api/internal/verify/invalid.token.here');
            
            assert.strictEqual(response.statusCode, 401);
            assert.strictEqual(response.body.valid, false);
        });
    });
});