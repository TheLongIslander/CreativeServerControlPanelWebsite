// utils.js
function getEasternTime() {
    const date = new Date();
    return date.toLocaleString('en-US', { timeZone: 'America/New_York' });
}

module.exports = {
    getEasternTime
};