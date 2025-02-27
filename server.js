require("dotenv").config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const { check, validationResult } = require("express-validator");
const { Parser } = require("json2csv");
const multer = require("multer");
const csvParser = require("csv-parser");
const fs = require("fs");
const cron = require("node-cron");
const session = require("express-session");          // For session management
const bcrypt = require("bcryptjs");                   // For password hashing

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true })); // Parse POST bodies
app.set("view engine", "ejs");

app.use(session({
  secret: "your-very-secret-key", // Replace with a strong secret in production
  resave: false,
  saveUninitialized: false,
  rolling: true, // Reset the cookie expiration on every response
  cookie: { maxAge: 5 * 60 * 1000, secure: false } // 5 minutes, set secure to true in production with HTTPS
}));


const upload = multer({ dest: "uploads/" });

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/metering");

// ----- Meter Schema & Model -----
const meterSchema = new mongoose.Schema({
  meterId: { type: String, unique: true }
});
const Meter = mongoose.model("Meter", meterSchema);

// ----- Tenant Schema & Model -----
const tenantSchema = new mongoose.Schema({
  unitNumber: String,
  meterIds: [String],
  accountNumber: String,
  contactName: String,
  email: String,
  history: [
    {
      meter: String,
      date: { type: Date, default: Date.now },
      description: String,
      meterReadings: [{ type: mongoose.Schema.Types.ObjectId, ref: "MeterReading" }]
    }
  ]
});
const Tenant = mongoose.model("Tenant", tenantSchema);

// ----- MeterReading Schema & Model -----
const meterReadingSchema = new mongoose.Schema({
  meter: String,
  date: String,
  time: String,
  kWHNet: Number
});
meterReadingSchema.index({ meter: 1, date: 1, time: 1 }, { unique: true });
const MeterReading = mongoose.model("MeterReading", meterReadingSchema);

// ----- NEW: User Schema & Model -----
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true }
});
const User = mongoose.model("User", userSchema);

// ----- Metering Code -----
const API_URL = "https://api.dentcloud.io/v1";
const HEADERS = {
  "x-api-key": process.env.API_KEY,
  "x-key-id": process.env.KEY_ID
};

const CACHE_EXPIRATION = 60 * 60 * 1000; // 1 hour
let cachedMeters = { data: [], lastUpdated: 0 };
let cachedTopics = { data: [], lastUpdated: 0 };

function logApiRequest(endpoint, fullUrl, params, response) {
  console.log("\n=====================================");
  console.log(`🚀 OUTGOING API Request: ${fullUrl}`);
  console.log("📌 Endpoint:", endpoint);
  console.log("📌 Parameters:", params);
  console.log("✅ API Response:", JSON.stringify(response, null, 2));
  console.log("=====================================\n");
}

async function loadMeters() {
  if (Date.now() - cachedMeters.lastUpdated > CACHE_EXPIRATION) {
    try {
      const params = { request: "getMeters" };
      const fullUrl = `${API_URL}?${new URLSearchParams(params).toString()}`;
      const response = await axios.get(fullUrl, { headers: HEADERS });
      const meters = response.data.meters || [];
      cachedMeters = { data: meters, lastUpdated: Date.now() };
      logApiRequest("getMeters", fullUrl, params, response.data);
      for (const meterId of meters) {
        await Meter.updateOne(
          { meterId },
          { $setOnInsert: { meterId } },
          { upsert: true }
        );
      }
    } catch (error) {
      console.error("Error fetching meters:", error.message);
    }
  }
}

async function loadTopics() {
  if (Date.now() - cachedTopics.lastUpdated > CACHE_EXPIRATION) {
    try {
      const params = { request: "getTopics" };
      const fullUrl = `${API_URL}?${new URLSearchParams(params).toString()}`;
      const response = await axios.get(fullUrl, { headers: HEADERS });
      cachedTopics = { data: response.data.topics || [], lastUpdated: Date.now() };
      logApiRequest("getTopics", fullUrl, params, response.data);
    } catch (error) {
      console.error("Error fetching topics:", error.message);
    }
  }
}

async function fetchMeterData(params) {
  Object.keys(params).forEach(key => {
    if (params[key] === "" || params[key] === null) delete params[key];
  });
  if (params.topics) {
    params.topics = Array.isArray(params.topics) ? params.topics : [params.topics];
    if (!params.topics[0].startsWith("[")) {
      params.topics = "[" + params.topics.join(",") + "]";
    }
  }
  try {
    const fullUrl = `${API_URL}?${new URLSearchParams(params).toString()}`;
    console.log("\nFULL API REQUEST:", fullUrl);
    const response = await axios.get(fullUrl, { headers: HEADERS });
    logApiRequest("getData", fullUrl, params, response.data);
    return response.data || {};
  } catch (error) {
    console.error("Error fetching meter data from API:", error.message);
    return { success: false, error: error.message };
  }
}

function safeNumber(val) {
  const num = parseFloat(val);
  return isNaN(num) ? 0 : num;
}

function calculateMonthlyConsumption(readings) {
  const monthly = {};
  readings.forEach(record => {
    const monthKey = record.date.substring(0, 7);
    const meter = record.meter;
    if (!monthly[meter]) {
      monthly[meter] = {};
    }
    if (!monthly[meter][monthKey]) {
      monthly[meter][monthKey] = { min: safeNumber(record.kWHNet), max: safeNumber(record.kWHNet) };
    } else {
      monthly[meter][monthKey].min = Math.min(monthly[meter][monthKey].min, safeNumber(record.kWHNet));
      monthly[meter][monthKey].max = Math.max(monthly[meter][monthKey].max, safeNumber(record.kWHNet));
    }
  });
  const consumption = {};
  for (const meter in monthly) {
    consumption[meter] = {};
    for (const month in monthly[meter]) {
      consumption[meter][month] = monthly[meter][month].max - monthly[meter][month].min;
    }
  }
  return { monthly, consumption };
}

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

let jobList = [];
let jobIdCounter = 1;

function scheduleJob(cronExpression, jobType) {
  let task;
  if (jobType === "Load Meters") {
    task = cron.schedule(cronExpression, async () => {
      console.log("Scheduled job: Loading meters...");
      await loadMeters();
    });
  } else if (jobType === "Fetch Meter Data") {
    task = cron.schedule(cronExpression, async () => {
      console.log("Scheduled job: Fetching meter data for all stored meters...");
      try {
        const meterDocs = await Meter.find({});
        for (const doc of meterDocs) {
          const meterId = doc.meterId;
          const params = {
            request: "getData",
            meter: meterId,
            topics: "kWHNet",
            year: new Date().getFullYear(),
            month: ("0" + (new Date().getMonth() + 1)).slice(-2)
          };
          const result = await fetchMeterData(params);
          console.log(`Fetched data for meter ${meterId}:`, result);
          if (result.topics) {
            for (const reading of result.topics) {
              Object.keys(reading).forEach(async key => {
                if (key.startsWith("kWHNet/Elm/")) {
                  const letter = key.substring("kWHNet/Elm/".length);
                  const meterSuffix = meterId + "_" + letter;
                  const filter = { meter: meterSuffix, date: reading.date, time: reading.time };
                  const update = {
                    meter: meterSuffix,
                    date: reading.date,
                    time: reading.time,
                    kWHNet: safeNumber(reading[key])
                  };
                  try {
                    await MeterReading.updateOne(filter, { $setOnInsert: update }, { upsert: true });
                  } catch (err) {
                    if (err.code !== 11000)
                      console.error(`Error upserting meter reading for ${meterSuffix}:`, err);
                  }
                }
              });
            }
          }
        }
      } catch (err) {
        console.error("Error in scheduled fetch of meter data:", err);
      }
    });
  } else {
    return null;
  }
  const job = {
    id: jobIdCounter++,
    cronExpression,
    jobType,
    task
  };
  jobList.push(job);
  console.log(`Job scheduled [${job.id}]: ${job.jobType} (${job.cronExpression})`);
  return job;
}

// ----- Public Authentication Routes -----
app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.render("login", { error: "Invalid username or password" });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.render("login", { error: "Invalid username or password" });
    }
    req.session.userId = user._id;
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.render("login", { error: "An error occurred. Please try again." });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// ----- User Management Routes (Protected) -----
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  next();
}

app.get("/users", requireAuth, async (req, res) => {
  try {
    const users = await User.find({});
    res.render("users", { users });
  } catch (err) {
    res.status(500).send("Error retrieving users.");
  }
});

app.get("/users/new", requireAuth, (req, res) => {
  res.render("newUser", { error: null });
});

app.post("/users/new", requireAuth, async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, password: hashedPassword });
    res.redirect("/users");
  } catch (err) {
    console.error(err);
    res.render("newUser", { error: "Error creating user. Username may already exist." });
  }
});

// ----- Global Authentication Middleware -----
// This middleware forces login on all routes except for "/login" and "/logout".
app.use((req, res, next) => {
  const publicPaths = ["/login", "/logout"];
  if (!req.session.userId && !publicPaths.includes(req.path)) {
    return res.redirect("/login");
  }
  next();
});

// ----- Existing Routes (All now protected by the global middleware) -----

app.get("/cron/jobs", (req, res) => {
  res.json(jobList.map(job => ({ id: job.id, cronExpression: job.cronExpression, jobType: job.jobType })));
});

app.post("/cron", (req, res) => {
  const { cronExpression, jobType } = req.body;
  const job = scheduleJob(cronExpression, jobType);
  if (job) {
    res.send(`<script>alert("Job added: ${job.jobType} (${job.cronExpression})"); window.location.href="/";</script>`);
  } else {
    res.send(`<script>alert("Failed to add job. Check job type."); window.location.href="/";</script>`);
  }
});

app.get("/tenants/export", async (req, res) => {
  try {
    const tenants = await Tenant.find({}).lean();
    const fields = ["unitNumber", "meterIds", "accountNumber", "contactName", "email"];
    const json2csvParser = new Parser({ fields });
    const csv = json2csvParser.parse(tenants);
    res.header("Content-Type", "text/csv");
    res.attachment("tenants.csv");
    return res.send(csv);
  } catch (err) {
    res.status(500).send("Error exporting tenants.");
  }
});

app.post("/tenants/import", upload.single("file"), async (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csvParser())
    .on("data", (data) => results.push(data))
    .on("end", async () => {
      try {
        for (let tenantData of results) {
          if (typeof tenantData.meterIds === "string") {
            tenantData.meterIds = tenantData.meterIds.split(",").map(id => id.trim());
          }
          let existing = await Tenant.findOne({ unitNumber: tenantData.unitNumber });
          if (existing) {
            existing.meterIds = tenantData.meterIds;
            existing.accountNumber = tenantData.accountNumber;
            existing.contactName = tenantData.contactName;
            existing.email = tenantData.email;
            await existing.save();
          } else {
            await Tenant.create(tenantData);
          }
        }
        res.send(`<script>alert("Tenants imported successfully."); window.location.href="/tenants";</script>`);
      } catch (err) {
        res.send(`<script>alert("Error importing tenants."); window.location.href="/tenants";</script>`);
      } finally {
        fs.unlinkSync(req.file.path);
      }
    });
});

app.get("/tenants/csv", async (req, res) => {
  await loadMeters();
  const tenants = await Tenant.find({});
  let assigned = {};
  tenants.forEach(tenant => {
    tenant.meterIds.forEach(mid => { assigned[mid] = true; });
  });
  let available = [];
  cachedMeters.data.forEach(baseMeter => {
    if (!assigned[baseMeter + "_A"]) available.push(baseMeter + "_A");
    if (!assigned[baseMeter + "_B"]) available.push(baseMeter + "_B");
  });
  res.render("tenantsCsv", { availableMeters: available, tenants });
});

app.get("/tenants/email", async (req, res) => {
  const tenants = await Tenant.find({});
  res.render("tenantsEmail", { tenants });
});

app.get("/", async (req, res) => {
  await loadMeters();
  await loadTopics();
  res.render("index", {
    meters: cachedMeters.data,
    availableTopics: cachedTopics.data,
    meterData: {},
    queryParams: {},
    monthlyConsumption: {},
    monthlyDetails: {},
    costPerKwh: 0.10,
    cronSchedule: jobList.map(job => `${job.jobType}: ${job.cronExpression}`).join(" | ")
  });
});

app.post(
  "/fetch-data",
  [
    check("request").notEmpty().withMessage("Request type is required"),
    check("meter").notEmpty().withMessage("At least one meter must be selected"),
    check("year").optional().isNumeric().withMessage("Year must be a number"),
    check("month").optional().isInt({ min: 1, max: 12 }).withMessage("Month must be between 01-12"),
    check("day").optional().isInt({ min: 1, max: 31 }).withMessage("Day must be between 01-31"),
    check("hour").optional().isInt({ min: 0, max: 23 }).withMessage("Hour must be between 00-23"),
    check("topics").notEmpty().withMessage("At least one topic must be selected")
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    
    if (req.body.topics && !Array.isArray(req.body.topics)) {
      req.body.topics = [req.body.topics];
    }
    
    let meterList = Array.isArray(req.body.meter) ? req.body.meter : [req.body.meter];
    let allMeterData = [];
    
    for (const meterId of meterList) {
      let paramsForMeter = { ...req.body, meter: meterId };
      if (!paramsForMeter.day) delete paramsForMeter.day;
      if (!paramsForMeter.hour) delete paramsForMeter.hour;
      
      const result = await fetchMeterData(paramsForMeter);
      if (result.topics) {
        allMeterData.push(result.topics);
      } else {
        allMeterData.push([result]);
      }
    }
    const combinedTopics = allMeterData.flat();
    const meterData = { topics: combinedTopics };
    
    for (const reading of meterData.topics) {
      Object.keys(reading).forEach(async key => {
        if (key.startsWith("kWHNet/Elm/")) {
          const letter = key.substring("kWHNet/Elm/".length);
          const meterSuffix = req.body.meter + "_" + letter;
          const filter = { meter: meterSuffix, date: reading.date, time: reading.time };
          const update = {
            meter: meterSuffix,
            date: reading.date,
            time: reading.time,
            kWHNet: safeNumber(reading[key])
          };
          try {
            await MeterReading.updateOne(filter, { $setOnInsert: update }, { upsert: true });
          } catch (err) {
            if (err.code !== 11000)
              console.error(`Error upserting meter reading for ${meterSuffix}:`, err);
          }
        }
      });
    }
    
    let combinedReadings = [];
    meterData.topics.forEach(reading => {
      Object.keys(reading).forEach(key => {
        if (key.startsWith("kWHNet/Elm/")) {
          const letter = key.substring("kWHNet/Elm/".length);
          combinedReadings.push({
            date: reading.date,
            meter: req.body.meter + "_" + letter,
            kWHNet: safeNumber(reading[key])
          });
        }
      });
    });
    
    const monthlyResult = calculateMonthlyConsumption(combinedReadings);
    const monthlyConsumption = monthlyResult.consumption;
    const monthlyDetails = monthlyResult.monthly;
    const costPerKwh = 0.10;
    
    if (req.body.meter) {
      try {
        const tenant = await Tenant.findOne({ meterIds: req.body.meter });
        if (tenant) {
          const readings = await MeterReading.find({ meter: req.body.meter });
          const readingIds = readings.map(r => r._id);
          tenant.history.push({
            meter: req.body.meter,
            description: "Meter readings fetched on " + new Date().toLocaleString(),
            meterReadings: readingIds
          });
          await tenant.save();
        }
      } catch (err) {
        console.error("Error updating tenant history for meter:", err);
      }
    }
    
    res.render("index", {
      meters: cachedMeters.data,
      availableTopics: cachedTopics.data,
      meterData,
      queryParams: req.body,
      monthlyConsumption,
      monthlyDetails,
      costPerKwh,
      cronSchedule: jobList.map(job => `${job.jobType}: ${job.cronExpression}`).join(" | ")
    });
  }
);

app.get("/tenants", async (req, res) => {
  try {
    const tenants = await Tenant.find({});
    res.render("tenants", { tenants });
  } catch (err) {
    res.status(500).send("Error retrieving tenants.");
  }
});

app.post("/tenants/delete", async (req, res) => {
  try {
    const ids = req.body.tenantIds;
    const tenantIds = Array.isArray(ids) ? ids : [ids];
    if (!tenantIds || tenantIds.length === 0) {
      return res.redirect("/tenants");
    }
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    res.redirect("/tenants");
  } catch (err) {
    res.status(500).send("Error deleting tenants.");
  }
});

app.post("/tenants/emailMultiple", async (req, res) => {
  try {
    let { tenantIds, startDate, endDate, costPerKwh } = req.body;
    if (!tenantIds) {
      return res.status(400).send("No tenants selected.");
    }
    tenantIds = Array.isArray(tenantIds) ? tenantIds : [tenantIds];
    for (const id of tenantIds) {
      const tenant = await Tenant.findById(id);
      if (!tenant) continue;
      const meterReadings = await MeterReading.find({ meter: { $in: tenant.meterIds } }).sort({ date: 1, time: 1 });
      let minKWH = Infinity;
      let maxKWH = -Infinity;
      meterReadings.forEach(r => {
        if ((startDate && r.date < startDate) || (endDate && r.date > endDate)) return;
        let value = safeNumber(r.kWHNet);
        if (value < minKWH) minKWH = value;
        if (value > maxKWH) maxKWH = value;
      });
      if (minKWH === Infinity || maxKWH === -Infinity) continue;
      const totalKWH = maxKWH - minKWH;
      const totalCost = totalKWH * parseFloat(costPerKwh);
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: tenant.email,
        subject: `Usage Invoice for Unit ${tenant.unitNumber}`,
        text: `Hello ${tenant.contactName},

Here is your usage invoice for the period ${startDate} to ${endDate}:
Total kWHNet: ${totalKWH.toFixed(3)} kWh
Cost per kWh: $${parseFloat(costPerKwh).toFixed(2)}
Total Amount Due: $${totalCost.toFixed(2)}

Please remit payment via check.

Thank you,
Metering App Team`
      };
      await transporter.sendMail(mailOptions);
    }
    res.send(`<script>alert("Usage invoice emails sent successfully."); window.location.href="/tenants";</script>`);
  } catch (err) {
    console.error("Error sending usage invoice emails:", err);
    res.send(`<script>alert("Error sending usage invoice emails."); window.location.href="/tenants";</script>`);
  }
});

app.get("/tenants/new", async (req, res) => {
  try {
    // Get all existing tenants and their assigned meters.
    const tenants = await Tenant.find({});
    let assigned = {};
    tenants.forEach(tenant => {
      tenant.meterIds.forEach(mid => { assigned[mid] = true; });
    });

    // Get unique meters from the MeterReading collection (used by the Meters & Assignments page)
    const uniqueMeters = await MeterReading.distinct("meter");
    let available = [];
    uniqueMeters.forEach(meter => {
      if (!assigned[meter]) available.push(meter);
    });

    res.render("newTenant", { availableMeters: available });
  } catch (err) {
    res.status(500).send("Error retrieving available meters for new tenant.");
  }
});

app.post("/tenants", async (req, res) => {
  try {
    const { unitNumber, meterIds, accountNumber, contactName, email } = req.body;
    const meterIdArray = Array.isArray(meterIds)
      ? meterIds
      : (meterIds ? meterIds.split(",").map(id => id.trim()) : []);
    const tenant = new Tenant({
      unitNumber,
      meterIds: meterIdArray,
      accountNumber,
      contactName,
      email,
      history: []
    });
    await tenant.save();
    res.redirect("/tenants");
  } catch (err) {
    res.status(500).send("Error creating tenant.");
  }
});

// --- Updated GET route for editing tenant with available meters ---
app.get("/tenants/:id/edit", async (req, res) => {
  try {
    // Retrieve the tenant to be edited.
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).send("Tenant not found.");

    // Get all tenants except the current one.
    const otherTenants = await Tenant.find({ _id: { $ne: tenant._id } });
    let assigned = {};
    otherTenants.forEach(t => {
      t.meterIds.forEach(mid => { assigned[mid] = true; });
    });

    // Pull available meters from the MeterReading collection (as in the Meters & Assignments page).
    const uniqueMeters = await MeterReading.distinct("meter");
    let available = [];
    uniqueMeters.forEach(meter => {
      if (!assigned[meter]) {
        available.push(meter);
      }
    });

    // Ensure the tenant's currently assigned meters are also included.
    tenant.meterIds.forEach(mid => {
      if (!available.includes(mid)) available.push(mid);
    });

    res.render("editTenant", { tenant, availableMeters: available });
  } catch (err) {
    res.status(500).send("Error retrieving tenant details for edit.");
  }
});

// --- Updated POST route for editing tenant to handle checkbox input ---
app.post("/tenants/:id/edit", async (req, res) => {
  try {
    const { unitNumber, meterIds, accountNumber, contactName, email } = req.body;
    const meterIdArray = Array.isArray(meterIds) ? meterIds : (meterIds ? meterIds.split(",").map(id => id.trim()) : []);
    await Tenant.findByIdAndUpdate(req.params.id, {
      unitNumber,
      meterIds: meterIdArray,
      accountNumber,
      contactName,
      email
    });
    res.redirect("/tenants/" + req.params.id);
  } catch (err) {
    res.status(500).send("Error updating tenant details.");
  }
});

app.get("/tenants/:id", async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).send("Tenant not found.");
    const meterReadings = await MeterReading.find({ meter: { $in: tenant.meterIds } }).sort({ date: 1, time: 1 });
    res.render("tenantDetail", { tenant, meterReadings });
  } catch (err) {
    res.status(500).send("Error retrieving tenant details.");
  }
});

app.get("/meters", async (req, res) => {
  try {
    const uniqueMeters = await MeterReading.distinct("meter");
    const tenants = await Tenant.find({});
    let assigned = {};
    tenants.forEach(tenant => {
      tenant.meterIds.forEach(mid => {
        assigned[mid] = `${tenant.unitNumber} (${tenant.contactName})`;
      });
    });
    let assignedMeters = [];
    let unassignedMeters = [];
    uniqueMeters.forEach(mid => {
      if (assigned[mid]) {
        assignedMeters.push({ meter: mid, tenant: assigned[mid] });
      } else {
        unassignedMeters.push(mid);
      }
    });
    res.render("meters", { assignedMeters, unassignedMeters });
  } catch (err) {
    res.status(500).send("Error retrieving meter assignments.");
  }
});

app.post("/tenants/:id/invoice", async (req, res) => {
  try {
    const { startDate, endDate, costPerKwh } = req.body;
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).send("Tenant not found.");
    const meterReadings = await MeterReading.find({ meter: { $in: tenant.meterIds } }).sort({ date: 1, time: 1 });
    let minKWH = Infinity;
    let maxKWH = -Infinity;
    meterReadings.forEach(r => {
      if ((startDate && r.date < startDate) || (endDate && r.date > endDate)) return;
      let value = safeNumber(r.kWHNet);
      if (value < minKWH) minKWH = value;
      if (value > maxKWH) maxKWH = value;
    });
    if (minKWH === Infinity || maxKWH === -Infinity) {
      return res.status(400).send("No valid meter readings found in the specified date range.");
    }
    const totalKWH = maxKWH - minKWH;
    const totalCost = totalKWH * parseFloat(costPerKwh);
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: tenant.email,
      subject: `Invoice for Unit ${tenant.unitNumber}`,
      text: `Hello ${tenant.contactName},

Please find your invoice details below for the period ${startDate} to ${endDate}:
Total kWHNet: ${totalKWH.toFixed(3)} kWh
Cost per kWh: $${parseFloat(costPerKwh).toFixed(2)}
Total Amount Due: $${totalCost.toFixed(2)}

Please remit payment via check.

Thank you,
Metering App Team`
    };
    await transporter.sendMail(mailOptions);
    res.send(`<script>alert("Invoice email sent successfully."); window.location.href="/tenants";</script>`);
  } catch (err) {
    console.error("Error sending invoice email:", err);
    res.send(`<script>alert("Error sending invoice email."); window.location.href="/tenants";</script>`);
  }
});

app.get("/dashboard", async (req, res) => {
  try {
    // Use the provided month filter or default to the current month (YYYY-MM)
    let filterMonth = req.query.month;
    if (!filterMonth) {
      const now = new Date();
      filterMonth = now.toISOString().substring(0, 7);
    }
    // Get all tenants
    const tenants = await Tenant.find({});
    let tenantData = [];
    let buildingUsage = 0;
    // Process each tenant
    for (let tenant of tenants) {
      // Find meter readings for tenant's meters where the date starts with filterMonth
      const readings = await MeterReading.find({
        meter: { $in: tenant.meterIds },
        date: { $regex: '^' + filterMonth }
      }).sort({ date: 1, time: 1 });
      
      // Group readings by meter ID to calculate usage (max - min)
      let usagePerMeter = {};
      tenant.meterIds.forEach(meter => {
        usagePerMeter[meter] = { min: Infinity, max: -Infinity };
      });
      readings.forEach(r => {
        const meter = r.meter;
        const value = r.kWHNet;
        if (value < usagePerMeter[meter].min) usagePerMeter[meter].min = value;
        if (value > usagePerMeter[meter].max) usagePerMeter[meter].max = value;
      });
      let usageFinal = {};
      let totalUsage = 0;
      for (let meter in usagePerMeter) {
        const group = usagePerMeter[meter];
        if (group.min === Infinity || group.max === -Infinity) {
          usageFinal[meter] = 0;
        } else {
          const usage = group.max - group.min;
          usageFinal[meter] = usage;
          totalUsage += usage;
        }
      }
      buildingUsage += totalUsage;
      tenantData.push({
        tenant,
        usage: usageFinal,
        totalUsage
      });
    }
    res.render("dashboard", { tenantData, buildingUsage, filterMonth });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating dashboard");
  }
});

// ----- Start the Server and Create Default Admin User if Needed -----
app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  await loadMeters();
  await loadTopics();
  // Create default admin user if not present
  const adminUser = await User.findOne({ username: "Admin" });
  if (!adminUser) {
    const hashedPassword = await bcrypt.hash("Metering", 10);
    await User.create({ username: "Admin", password: hashedPassword });
    console.log("Default admin user created: username 'Admin', password 'Metering'");
  }
});
