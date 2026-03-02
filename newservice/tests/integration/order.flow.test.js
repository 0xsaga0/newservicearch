// tests/integration/order.flow.test.js
const request = require('supertest');
const assert = require('assert');
const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');

// Импортируем сервисы
const authApp = require('../../auth-service/server');
const orderApp = require('../../order-service/server');
const paymentApp = require('../../payment-service/server');

describe('Order Flow Integration Tests', () => {
    let mockAxios;
    let authToken;
    let userId;
    
    beforeAll(() => {
        // Мокаем HTTP запросы между сервисами
        mockAxios = new MockAdapter(axios);
    });
    
    afterEach(() => {
        mockAxios.reset();
    });
    
    describe('Complete Order Creation Flow', () => {
        it('should create order and process payment successfully', async () => {
            // Шаг 1: Регистрация пользователя
            const registerResponse = await request(authApp)
                .post('/api/auth/register')
                .send({
                    username: 'integration_user',
                    email: 'integration@example.com',
                    password: 'password123'
                });
            
            assert.strictEqual(registerResponse.statusCode, 201);
            authToken = registerResponse.body.tokens.accessToken;
            userId = registerResponse.body.user.id;
            
            // Шаг 2: Мокаем ответы сервисов
            mockAxios
                .onGet(new RegExp('/api/internal/verify/.*'))
                .reply(200, {
                    valid: true,
                    user: { id: userId, email: 'integration@example.com', role: 'user' }
                })
                .onPost('/api/internal/payments')
                .reply(201, {
                    paymentId: 'pay_123456',
                    status: 'completed'
                });
            
            // Шаг 3: Создание заказа
            const orderResponse = await request(orderApp)
                .post('/api/orders')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    items: [
                        {
                            productId: 101,
                            name: 'Test Product',
                            quantity: 2,
                            price: 500
                        }
                    ],
                    shippingAddress: 'Test Address, 123',
                    paymentMethod: 'card'
                });
            
            assert.strictEqual(orderResponse.statusCode, 201);
            assert.ok(orderResponse.body.order.id);
            assert.strictEqual(orderResponse.body.order.totalAmount, 1000);
            assert.strictEqual(orderResponse.body.order.status, 'paid');
            
            // Шаг 4: Проверка получения заказа
            const getOrderResponse = await request(orderApp)
                .get(`/api/orders/${orderResponse.body.order.id}`)
                .set('Authorization', `Bearer ${authToken}`);
            
            assert.strictEqual(getOrderResponse.statusCode, 200);
            assert.strictEqual(getOrderResponse.body.id, orderResponse.body.order.id);
        });
        
        it('should handle payment service failure gracefully', async () => {
            // Регистрация пользователя
            const registerResponse = await request(authApp)
                .post('/api/auth/register')
                .send({
                    username: 'fail_user',
                    email: 'fail@example.com',
                    password: 'password123'
                });
            
            authToken = registerResponse.body.tokens.accessToken;
            
            // Мокаем отказ payment service
            mockAxios
                .onGet(new RegExp('/api/internal/verify/.*'))
                .reply(200, { valid: true, user: { id: 2 } })
                .onPost('/api/internal/payments')
                .reply(503, { error: 'Service unavailable' });
            
            const orderResponse = await request(orderApp)
                .post('/api/orders')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    items: [{ productId: 101, name: 'Test', quantity: 1, price: 100 }],
                    shippingAddress: 'Test',
                    paymentMethod: 'card'
                });
            
            assert.strictEqual(orderResponse.statusCode, 201);
            assert.strictEqual(orderResponse.body.order.status, 'payment_failed');
            assert.ok(orderResponse.body.order.paymentId === null);
        });
        
        it('should handle auth service timeout', async () => {
            mockAxios
                .onGet(new RegExp('/api/internal/verify/.*'))
                .timeout();
            
            const orderResponse = await request(orderApp)
                .post('/api/orders')
                .set('Authorization', 'Bearer some-token')
                .send({
                    items: [{ productId: 101, name: 'Test', quantity: 1, price: 100 }],
                    shippingAddress: 'Test'
                });
            
            assert.strictEqual(orderResponse.statusCode, 504);
            assert.ok(orderResponse.body.message.includes('timeout'));
        });
    });
    
    describe('Order Cancellation Flow', () => {
        it('should cancel pending order', async () => {
            // Создаем заказ
            const orderResponse = await request(orderApp)
                .post('/api/orders')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    items: [{ productId: 101, name: 'Test', quantity: 1, price: 100 }],
                    shippingAddress: 'Test',
                    paymentMethod: 'balance'
                });
            
            const orderId = orderResponse.body.order.id;
            
            // Отменяем заказ
            const cancelResponse = await request(orderApp)
                .post(`/api/orders/${orderId}/cancel`)
                .set('Authorization', `Bearer ${authToken}`);
            
            assert.strictEqual(cancelResponse.statusCode, 200);
            assert.strictEqual(cancelResponse.body.order.status, 'cancelled');
            
            // Проверяем, что заказ отменен
            const getResponse = await request(orderApp)
                .get(`/api/orders/${orderId}`)
                .set('Authorization', `Bearer ${authToken}`);
            
            assert.strictEqual(getResponse.body.status, 'cancelled');
        });
        
        it('should not allow cancelling delivered order', async () => {
            // Создаем доставленный заказ
            const order = {
                id: 999,
                userId: 1,
                status: 'delivered',
                items: []
            };
            
            // Добавляем напрямую в массив (в реальном тесте через БД)
            orders.push(order);
            
            const cancelResponse = await request(orderApp)
                .post('/api/orders/999/cancel')
                .set('Authorization', `Bearer ${authToken}`);
            
            assert.strictEqual(cancelResponse.statusCode, 400);
            assert.ok(cancelResponse.body.message.includes('cannot be cancelled'));
        });
    });
});