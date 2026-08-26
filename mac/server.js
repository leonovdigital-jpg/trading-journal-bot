const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { execSync, spawn, exec } = require('child_process');

const app = express();
const PORT = 3333;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = path.join(__dirname, 'db', 'checklist.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database error:', err);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS checklist_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      instrument TEXT,
      direction TEXT,
      q1 TEXT,
      q2 TEXT,
      q3 TEXT,
      q4 TEXT,
      q5 TEXT,
      q6 TEXT,
      result TEXT
    )
  `);
}

function getTodayDateString() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

app.post('/api/log', (req, res) => {
  const { instrument, direction, answers, result } = req.body;
  const timestamp = new Date().toISOString();

  db.run(
    `INSERT INTO checklist_log (timestamp, instrument, direction, q1, q2, q3, q4, q5, q6, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [timestamp, instrument, direction, answers[0], answers[1], answers[2], answers[3], answers[4], answers[5], result],
    function(err) {
      if (err) {
        console.error('Log error:', err);
        res.json({ success: false, error: err.message });
      } else {
        res.json({ success: true, logId: this.lastID });
      }
    }
  );
});

app.get('/api/stats', (req, res) => {
  const today = getTodayDateString();

  db.all(
    `SELECT COUNT(*) as count FROM checklist_log
     WHERE result = 'allowed' AND DATE(timestamp) = ?`,
    [today],
    (err, rows) => {
      if (err) {
        res.json({ allowCount: 0, rejectCount: 0 });
      } else {
        const allowCount = rows[0].count;
        db.all(
          `SELECT COUNT(*) as count FROM checklist_log
           WHERE result = 'rejected' AND DATE(timestamp) = ?`,
          [today],
          (err, rows) => {
            const rejectCount = rows[0].count;
            res.json({ allowCount, rejectCount });
          }
        );
      }
    }
  );
});

app.post('/api/open-terminal', (req, res) => {
  exec('open "http://localhost:3333"', (error) => {
    if (error) {
      console.error('Open terminal error:', error);
      res.json({ success: false, error: error.message });
    } else {
      res.json({ success: true });
    }
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Checklist server running at http://127.0.0.1:${PORT}`);
  console.log(`Available on local network at http://$(hostname -I):${PORT}`);
});

db.on('error', (err) => {
  console.error('Database error:', err);
});
