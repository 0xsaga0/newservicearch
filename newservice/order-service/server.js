// order-service/server.js
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const CircuitBreaker = require('opossum');
const app = express();

// Конфигурация сервисов
const services = {
    auth: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
    payment: process.env.PAYMENT_SERVICE_URL || 'http://localhost:3003',
    inventory: process.env.INVENTORY_SERVICE_URL || 'http://localhost:3004',
    notification: process.env.NOTIFY_SERVICE_URL || 'http://localhost:3005'
};

// Circuit Breaker для защиты от каскадных отказов
const breakerOptions = {
    timeout: 3000, // Если запрос длится дольше 3 секунд - считать ошибкой
    errorThresholdPercentage: 50, // При 50% ошибок открыть цепь
    resetTimeout: 30000 // Через 30 секунд попробовать снова
};

// Создание circuit breaker для каждого внешнего сервиса
const authBreaker = new CircuitBreaker(
    async (token) => {
        const response = await axios.get(`${services.auth}/api/internal/verify/${token}`, {
            timeout: 2000
        });
        return response.data;
    },
    breakerOptions
);

const paymentBreaker = new CircuitBreaker(
    async (paymentData) => {
        const response = await axios.post(`${services.payment}/api/internal/payments`, paymentData, {
            timeout: 3000
        });
        return response.data;
    },
    breakerOptions
);

// Обработка событий circuit breaker
authBreaker.on('open', () => console.warn('Auth circuit breaker opened'));
authBreaker.on('halfOpen', () => console.log('Auth circuit breaker half-open'));
authBreaker.on('close', () => console.log('Auth circuit breaker closed'));

// Middleware для проверки токена с circuit breaker
const verifyToken = async (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({
            code: 401,
            message: 'No token provided'
        });
    }
    
    try {
        // Используем circuit breaker
        const result = await authBreaker.fire(token);
        
        if (result.valid) {
            req.user = result.user;
            next();
        } else {
            res.status(401).json({
                code: 401,
                message: 'Invalid token'
            });
        }
    } catch (error) {
        if (error.message.includes('timed out')) {
            res.status(504).json({
                code: 504,
                message: 'Auth service timeout',
                details: 'Please try again later'
            });
        } else if (error.message.includes('ECONNREFUSED')) {
            res.status(503).json({
                code: 503,
                message: 'Auth service unavailable',
                details: 'Service temporarily unavailable'
            });
        } else {
            res.status(500).json({
                code: 500,
                message: 'Internal server error',
                details: error.message
            });
        }
    }
};

// Создание заказа с компенсационными транзакциями
app.post('/api/orders', verifyToken, async (req, res) => {
    const { items, shippingAddress, paymentMethod } = req.body;
    
    // Генерация ID для отслеживания
    const requestId = uuidv4();
    console.log(`Processing order request ${requestId} for user ${req.user.id}`);
    
    try {
        // Шаг 1: Валидация
        if (!items?.length) {
            return res.status(400).json({
                code: 400,
                message: 'Order must contain items'
            });
        }
        
        // Шаг 2: Проверка наличия товаров (Inventory Service)
        let inventoryReserved = false;
        try {
            const inventoryCheck = await axios.post(`${services.inventory}/api/internal/reserve`, {
                items,
                requestId
            }, { timeout: 2000 });
            
            if (!inventoryCheck.data.reserved) {
                throw new Error('Insufficient inventory');
            }
            inventoryReserved = true;
        } catch (inventoryError) {
            console.error('Inventory check failed:', inventoryError.message);
            // Продолжаем, но отмечаем проблему
        }
        
        // Шаг 3: Расчет суммы
        const totalAmount = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        
        // Шаг 4: Создание заказа в БД
        const order = {
            id: Date.now(),
            orderNumber: `ORD-${new Date().getFullYear()}-${String(await getNextOrderNumber()).padStart(4, '0')}`,
            userId: req.user.id,
            items,
            totalAmount,
            status: inventoryReserved ? 'pending' : 'inventory_check_failed',
            paymentMethod,
            paymentId: null,
            shippingAddress,
            createdAt: new Date().toISOString(),
            requestId
        };
        
        // Сохраняем заказ
        orders.push(order);
        
        // Шаг 5: Обработка платежа если нужно
        if (paymentMethod === 'card' && inventoryReserved) {
            try {
                const payment = await paymentBreaker.fire({
                    orderId: order.id,
                    amount: totalAmount,
                    userId: req.user.id,
                    requestId
                });
                
                order.paymentId = payment.paymentId;
                order.status = 'paid';
                
            } catch (paymentError) {
                console.error('Payment failed:', paymentError);
                order.status = 'payment_failed';
                
                // Компенсация: отмена резерва товаров
                try {
                    await axios.post(`${services.inventory}/api/internal/release`, {
                        requestId,
                        reason: 'payment_failed'
                    });
                } catch (releaseError) {
                    console.error('Failed to release inventory:', releaseError);
                }
            }
        }
        
        // Шаг 6: Отправка уведомления
        try {
            await axios.post(`${services.notification}/api/internal/notify`, {
                userId: req.user.id,
                type: 'order_created',
                data: {
                    orderNumber: order.orderNumber,
                    totalAmount: order.totalAmount
                }
            });
        } catch (notifyError) {
            console.error('Notification failed:', notifyError.message);
            // Не прерываем основной процесс
        }
        
        res.status(201).json({
            message: 'Order created successfully',
            order,
            warnings: !inventoryReserved ? ['Inventory service temporarily unavailable'] : undefined
        });
        
    } catch (error) {
        console.error('Order creation failed:', error);
        
        // Компенсация при ошибке
        if (inventoryReserved) {
            try {
                await axios.post(`${services.inventory}/api/internal/release`, {
                    requestId,
                    reason: 'order_creation_failed'
                });
            } catch (releaseError) {
                console.error('Failed to release inventory:', releaseError);
            }
        }
        
        res.status(500).json({
            code: 500,
            message: 'Failed to create order',
            requestId
        });
    }
});

// Получение заказа с retry логикой
app.get('/api/orders/:id', verifyToken, async (req, res) => {
    const orderId = parseInt(req.params.id);
    const maxRetries = 3;
    let retryCount = 0;
    
    const findOrderWithRetry = async () => {
        try {
            const order = orders.find(o => o.id === orderId);
            
            if (!order) {
                throw new Error('Order not found');
            }
            
            if (order.userId !== req.user.id && req.user.role !== 'admin') {
                throw new Error('Access denied');
            }
            
            // Попытка обогатить данными о пользователе
            try {
                const userResponse = await axios.get(`${services.auth}/api/internal/users/${order.userId}`, {
                    timeout: 1000
                });
                order.user = userResponse.data;
            } catch (userError) {
                console.warn('Could not fetch user details:', userError.message);
            }
            
            return order;
            
        } catch (error) {
            if (error.message === 'Order not found' && retryCount < maxRetries) {
                retryCount++;
                console.log(`Retry ${retryCount} for order ${orderId}`);
                await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
                return findOrderWithRetry();
            }
            throw error;
        }
    };
    
    try {
        const order = await findOrderWithRetry();
        res.json(order);
    } catch (error) {
        if (error.message === 'Order not found') {
            res.status(404).json({
                code: 404,
                message: 'Order not found'
            });
        } else if (error.message === 'Access denied') {
            res.status(403).json({
                code: 403,
                message: 'Access denied'
            });
        } else {
            res.status(500).json({
                code: 500,
                message: 'Internal server error'
            });
        }
    }
});