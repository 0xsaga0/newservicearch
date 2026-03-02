// tests/error-handling/network.errors.test.js
const request = require('supertest');
const assert = require('assert');
const nock = require('nock');
const orderApp = require('../../order-service/server');

describe('Network Error Handling Tests', () => {
    
    beforeEach(() => {
        nock.cleanAll();
    });
    
    it('should handle DNS lookup failure', async () => {
        // Мокаем DNS ошибку
        nock('http://localhost:3001')
            .get('/api/internal/verify/token123')
            .replyWithError({
                code: 'ENOTFOUND',
                message: 'getaddrinfo ENOTFOUND localhost'
            });
        
        const response = await request(orderApp)
            .get('/api/orders')
            .set('Authorization', 'Bearer token123');
        
        assert.strictEqual(response.statusCode, 503);
        assert.ok(response.body.message.includes('unavailable'));
    });
    
    it('should handle connection refused', async () => {
        nock('http://localhost:3001')
            .get('/api/internal/verify/token123')
            .replyWithError({
                code: 'ECONNREFUSED',
                message: 'Connection refused'
            });
        
        const response = await request(orderApp)
            .get('/api/orders')
            .set('Authorization', 'Bearer token123');
        
        assert.strictEqual(response.statusCode, 503);
    });
    
    it('should handle socket timeout', async () => {
        nock('http://localhost:3001')
            .get('/api/internal/verify/token123')
            .delay(5000) // Задержка 5 секунд
            .reply(200, { valid: true });
        
        const response = await request(orderApp)
            .get('/api/orders')
            .set('Authorization', 'Bearer token123');
        
        assert.strictEqual(response.statusCode, 504);
    });
    
    it('should handle malformed JSON response', async () => {
        nock('http://localhost:3001')
            .get('/api/internal/verify/token123')
            .reply(200, 'not json at all');
        
        const response = await request(orderApp)
            .get('/api/orders')
            .set('Authorization', 'Bearer token123');
        
        assert.strictEqual(response.statusCode, 502);
    });
    
    it('should handle gradual backoff on retry', async () => {
        let attempts = 0;
        
        nock('http://localhost:3001')
            .get('/api/internal/verify/token123')
            .times(3)
            .reply(503, { error: 'Service busy' });
        
        const startTime = Date.now();
        
        const response = await request(orderApp)
            .get('/api/orders/1')
            .set('Authorization', 'Bearer token123');
        
        const duration = Date.now() - startTime;
        
        // Должна быть экспоненциальная задержка
        assert.ok(duration > 300); // минимум 100+200+300 мс
        assert.strictEqual(response.statusCode, 503);
    });
});