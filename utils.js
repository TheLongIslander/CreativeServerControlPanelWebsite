// utils.js
function getEasternTime() {
    const date = new Date();
    return date.toLocaleString('en-US', { timeZone: 'America/New_York' });
}
function getFormattedDate() {
    const date = new Date();
    const day = date.getDate();
    const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
    const year = date.getFullYear();
    let suffix = 'th';
    if (day % 10 === 1 && day !== 11) suffix = 'st';
    else if (day % 10 === 2 && day !== 12) suffix = 'nd';
    else if (day % 10 === 3 && day !== 13) suffix = 'rd';
  
    return `${month} ${day}${suffix}, ${year}`;
  }
  function getEasternDateHour() {
    const date = new Date();
    return date.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: 'numeric', year: 'numeric', month: 'long', day: 'numeric' });
}

module.exports = {
    getEasternTime,
    getFormattedDate,
    getEasternDateHour
};
