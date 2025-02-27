const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  // Always store hashed passwords!
  password: { type: String, required: true }
});

module.exports = mongoose.model("User", userSchema);
