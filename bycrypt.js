const bcrypt = require('bcrypt');

const password = 'TomSucksAtBedwars123!';
const saltRounds = 10;

bcrypt.hash(password, saltRounds, function(err, hash) {
  // Now you can store the hash in your database
  console.log(hash);
});