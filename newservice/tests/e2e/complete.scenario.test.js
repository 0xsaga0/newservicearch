// tests/e2e/complete.scenario.test.js
const request = require('supertest');
const assert = require('assert');
const { spawn } = require('child_process');
const waitOn = require('wait-on');

describe('Complete E2E Scenario', () => {
    let servers = [];
    let authToken;
    let userId;
    let orderId;
    
    beforeAll(async () => {
        // Запускаем все сервисы
        const services = ['auth-service', 'order-service', 'payment-service', 'inventory-service', 'notification-service'];
        
        services.forEach(service => {
            const server = spawn('node', [`../${service}/server.js`], {
                detached: true,
                stdio: 'ignore'
            });
            servers.push(server);
        });
        
        // Ждем пока все сервисы запустятся
        await waitOn({
            resources: [
                'tcp:3001', // auth
                'tcp:3002', // order
                'tcp:3003', // payment
                'tcp:3004', // inventory
                'tcp:3005'  // notification
            ],
            timeout: 10000
        });
    });
    
    afterAll(() => {
        // Останавливаем все сервисы
        servers.forEach(server => {
            process.kill(-server.pid);
        });
    });
    
    test('Scenario 1: User Registration and Login', async () => {
        // Регистрация
        const registerResponse = await request('http://localhost:3001')
            .post('/api/auth/register')
            .send({
                username: 'e2e_user',
                email: 'e2e@example.com',
                password: 'Test123456'
            });
        
        assert.strictEqual(registerResponse.statusCode, 201);
        assert.ok(registerResponse.body.user.id);
        
        userId = registerResponse.body.user.id;
        
        // Логин
        const loginResponse = await request('http://localhost:3001')
            .post('/api/auth/login')
            .send({
                email: 'e2e@example.com',
                password: 'Test123456'
            });
        
        assert.strictEqual(loginResponse.statusCode, 200);
        assert.ok(loginResponse.body.tokens.accessToken);
        
        authToken = loginResponse.body.tokens.accessToken;
    });
    
    test('Scenario 2: Product Catalog Browsing', async () => {
        // Получение списка товаров
        const productsResponse = await request('http://localhost:3004')
            .get('/api/products')
            .query({ category: 'electronics', limit: 10 });
        
        assert.strictEqual(productsResponse.statusCode, 200);
        assert.ok(Array.isArray(productsResponse.body.products));
    });
    
    test('Scenario 3: Create Order', async () => {
        const orderResponse = await request('http://localhost:3002')
            .post('/api/orders')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                items: [
                    {
                        productId: 101,
                        name: 'Ноутбук ASUS',
                        quantity: 1,
                        price: 75000
                    },
                    {
                        productId: 102,
                        name: 'Мышь беспроводная',
                        quantity: 2,
                        price: 1500
                    }
                ],
                shippingAddress: 'г. Москва, ул. Тестовая, д. 1',
                paymentMethod: 'balance'
            });
        
        assert.strictEqual(orderResponse.statusCode, 201);
        assert.ok(orderResponse.body.order.id);
        assert.strictEqual(orderResponse.body.order.totalAmount, 78000); // 75000 + 3000
        
        orderId = orderResponse.body.order.id;
    });
    
    test('Scenario 4: Check Balance and Pay', async () => {
        // Проверка баланса
        const balanceResponse = await request('http://localhost:3003')
            .get('/api/payments/balance')
            .set('Authorization', `Bearer ${authToken}`);
        
        assert.strictEqual(balanceResponse.statusCode, 200);
        const initialBalance = balanceResponse.body.balance;
        
        // Оплата заказа
        const paymentResponse = await request('http://localhost:3003')
            .post('/api/payments')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                orderId: orderId,
                paymentMethod: 'balance'
            });
        
        assert.strictEqual(paymentResponse.statusCode, 201);
        assert.ok(paymentResponse.body.payment.transactionId);
        
        // Проверка нового баланса
        const newBalanceResponse = await request('http://localhost:3003')
            .get('/api/payments/balance')
            .set('Authorization', `Bearer ${authToken}`);
        
        assert.strictEqual(newBalanceResponse.body.balance, initialBalance - 78000);
    });
    
    test('Scenario 5: Verify Order Status and Get Notifications', async () => {
        // Проверка статуса заказа
        const orderResponse = await request('http://localhost:3002')
            .get(`/api/orders/${orderId}`)
            .set('Authorization', `Bearer ${authToken}`);
        
        assert.strictEqual(orderResponse.statusCode, 200);
        assert.strictEqual(orderResponse.body.status, 'paid');
        
        // Получение уведомлений
        const notificationsResponse = await request('http://localhost:3005')
            .get('/api/notifications')
            .set('Authorization', `Bearer ${authToken}`);
        
        assert.strictEqual(notificationsResponse.statusCode, 200);
        
        // Должно быть уведомление о создании заказа
        const orderNotification = notificationsResponse.body.find(
            n => n.type === 'order_created' && n.data?.orderNumber === orderResponse.body.orderNumber
        );
        
        assert.ok(orderNotification);
    });
    
    test('Scenario 6: Check Order History', async () => {
        const historyResponse = await request('http://localhost:3003')
            .get('/api/payments/history')
            .set('Authorization', `Bearer ${authToken}`);
        
        assert.strictEqual(historyResponse.statusCode, 200);
        assert.ok(historyResponse.body.total >= 1);
        
        const payment = historyResponse.body.payments.find(p => p.orderId === orderId);
        assert.ok(payment);
        assert.strictEqual(payment.amount, 78000);
    });
});