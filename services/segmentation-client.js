const ServiceClient = require('./service-client');

const port = process.env.SEGMENTATION_PORT || 8010;
const client = new ServiceClient('SEGMENTATION', `http://127.0.0.1:${port}`, {
    maxRetries: 1,
    retryDelayMs: 1000,
    timeoutMs: 600000,
});

async function compute(filename) {
    const response = await client.request({
        method: 'POST',
        url: `/red-boundaries/${encodeURIComponent(filename)}`,
        timeout: 600000,
    });
    return response.data;
}

async function getCached(filename) {
    const response = await client.request({
        method: 'GET',
        url: `/red-boundaries/${encodeURIComponent(filename)}`,
        timeout: 10000,
    }, 0);
    return response.data;
}

async function healthCheck() {
    return client.healthCheck();
}

module.exports = { compute, getCached, healthCheck };
