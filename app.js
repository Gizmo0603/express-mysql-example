import express, { json, urlencoded } from 'express';
import session from 'express-session';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

const app = express();

app.use(express.static('public'));

// Parse form data
app.use(urlencoded({ extended: false }));

// Use json middleware for API - testing only at the moment
app.use(json());

// Set EJS as templating engine
app.set('view engine', 'ejs');

// Session middleware
app.use(session({
  secret: randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
}));

// Middleware to check response headers
app.use((req, res, next) => {
    res.on('finish', () => {
        console.log(`request url = ${req.originalUrl}`);
        console.log(res.getHeaders());
    });
    next();
});

// Create SQLite database
const db = new DatabaseSync(process.env.DB_PATH || 'database.sqlite');

// ToDo: Change this to something more secure
function md5(password) {
  return createHash('md5').update(password).digest('hex');
}

// Create users table if it doesn't exist
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      parent_id INTEGER,
      account_type TEXT NOT NULL DEFAULT 'parent' 
    )
  `); //parent_id/account_type used to identify created account as parent.
//Cards table. Contains user ID, 27TH APRIL (Added money to this DB)
    db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      number TEXT NOT NULL,
      expiry TEXT NOT NULL,
      money INTEGER NOT NULL DEFAULT 50, 
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `); //New table for Transactions
    db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER,
      to_user_id INTEGER,
      amount INTEGER NOT null,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);


  console.log('Tables ready');
} catch (err) {
  console.error('Error creating table:', err.message);
  process.exit(1);
}

// Custom middleware for authentication
function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

// Login page
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// ToDo: Move the controller and routing logic to different files to keep things clean.
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render('login', { error: 'Email and password are required' });
  }
  try {
    const row = db.prepare('SELECT * FROM users WHERE email = ? AND password = ?').get(email, md5(password));
    if (!row) {
      return res.render('login', { error: 'Invalid email or password' });
    }
    req.session.userId = row.id;
    req.session.userName = row.name;
    req.session.accountType = row.account_type
    res.redirect('/main');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Database error');
  }
});

app.get('/main', requireLogin, (req, res) => { //get route. Requirelogin makes sure the user is logged in.

  const user = db.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).get(req.session.userId); //gets users detail from DB via user id (found in current session)

  const cards = db.prepare(
    'SELECT * FROM cards WHERE user_id = ?'
  ).all(req.session.userId); //gets all linked cards + data

 const transactions = db.prepare(`
  SELECT 
    t.amount,
    t.created_at,
    u1.name AS from_name,
    u2.name AS to_name
  FROM transactions t
  LEFT JOIN users u1 ON t.from_user_id = u1.id
  LEFT JOIN users u2 ON t.to_user_id = u2.id
  WHERE t.from_user_id = ? OR t.to_user_id = ?
  ORDER BY t.created_at DESC
  `).all(req.session.userId, req.session.userId);

  res.render('main_screen', {
    userName: user.name,
    cards,
    accountType: req.session.accountType, //Gets account from session (Parent/Child)
    transactions
  }); //shows all this stuff on page via render.
});


app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', (req, res) => { //same as before. Look at previous future me.

  const { username, email, password } = req.body; //Gets the data into the requested bodies.

  if (!username || !email || !password) {
    return res.render('register', { error: 'All fields are required' }); //Disallows empty fields. shows error
  }

  try {
    const existing = db.prepare(
      'SELECT * FROM users WHERE email = ?'
    ).get(email); //checks user table for same email/account. Returns user of ails.

    if (existing) {
      return res.render('register', { error: 'Email already registered' }); //Duplicate accounts (checks)
    }

    const result = db.prepare( //New parent user in db.
      'INSERT INTO users (name, email, password, parent_id, account_type) VALUES (?, ?, ?, ?, ?)'
    ).run(username, email, md5(password), null, 'parent'); //Added Parent_id/Account_type to give parents unique modifier.

    const userId = result.lastInsertRowid; //gets id of new user.
    generateCard(userId, 'parent'); //calls gencard, links to that card + gives it "parent" id.

    res.redirect('/login'); //To login. Again, look back to previous future me.

  } catch (err) {
    console.error(err);
    return res.status(500).send('Database error'); //any error with DB causes this.
  }
});

app.post('/create-child', requireLogin, (req, res) => {

  const {username, email, password, funding} = req.body; //reads info from the forms.
  const parentId = req.session.userId //Assigns the parent_id from the session of the logged in user.

  const amount = Math.round(parseFloat(funding) * 100); //Changes everything to pence. Math.round prevents long digit numbers (e.g 5.0000001)

  if (isNaN(amount) || amount < 1) { //enforce minimum funding (1p)
    return res.status(400).send("Minimum funding is 0.01p");
  }
  try {
  const parentCard = db.prepare(
    'SELECT * FROM cards WHERE user_id = ?'
  ).get(parentId)
  
    if (!parentCard || parentCard.money < amount) { // Should check if parent has enough money
      return res.status(400).send("Not enough money.") 
    }

    const result = db.prepare('INSERT INTO users (name, email, password, parent_id, account_type) VALUES (?, ?, ?, ?, ?)').run(username, email, md5(password), parentId, 'child'); //Inserts into the DB + Creates child

    const childId = result.lastInsertRowid;

    generateCard(childId, 'child'); //Generates card for child account.

    db.prepare(' UPDATE cards SET money = money - ? WHERE user_id = ?').run(amount,parentId); //Should transfer money from parent. Record as well.
    db.prepare(' UPDATE cards SET money = money + ? WHERE user_id = ?').run(amount,childId); //Same as above, but adding to child
    db.prepare(`INSERT INTO transactions (from_user_id, to_user_id, amount) VALUES (?, ?, ?)`).run(parentId, childId, amount);

    return res.redirect('/main')

  } catch (err) {
  console.error(err);
  res.status(500).send(err.message);
}
})

app.get('/settings', requireLogin, (req, res) => {
  res.render('settings', {
    username: req.session.username,
    accountType: req.session.accountType
  });
});

function generateCard(userId, accountType = 'parent') { //Generates card details (Randomly) in db

  const types = ["Visa", "Mastercard"]; //chooses between Visa/Mastercard (Do not believe its needed, but I transferred it regardless)
  const type = types[Math.floor(Math.random() * types.length)];
  const last4 = Math.floor(1000 + Math.random() * 9000); //Randomly generate last 4 digits of card.

  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0"); //Both Expirty dates.
  const year = String(Math.floor(Math.random() * 5) + 25);

  const startingMoney = accountType === 'parent' ? 5000 : 0; //Starting funds (Changed to 5000: 0; 50 in pennies.)

  db.prepare(` 
    INSERT INTO cards (user_id, type, number, expiry, money)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    userId,
    type,
    `**** **** **** ${last4}`,
    `${month}/${year}`,
    startingMoney
  ); //Actual DB insertion. Specifically into "Cards"
}

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Home - List all users (uses requireLogin middleware)
app.get('/', requireLogin, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM users ORDER BY id DESC').all();
    res.render('index', { users: rows, userName: req.session.userName });
  } catch (err) {
    console.error(err);
    return res.status(500).send('Database error: ' + err);
  }
});

//Account Deletion. TODO: Make it delete child accounts as well.
app.post('/delete-account', requireLogin, (req, res) => {
  const userId = req.session.userId;

  try{
    db.prepare('DELETE FROM cards WHERE user_id = ?').run(userId);

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    req.session.destroy(() => {
      res.redirect('/register');
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Database Error')
  }
})

app.get('/create-child', requireLogin, (req, res) => {
  res.render('create-child', { error: null})
}); //Renders "create-child ejs"

// Home API - List all users
app.get('/api', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM users ORDER BY id DESC').all();
    res.json({ users: rows, userName: req.session.userName });
  } catch (err) {
    console.error(err);
    return res.status(500).send('Database error: ' + err);
  }
});

// Add a new user
app.post('/add', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).send('Name, email, and password are required');
  }
  try {
    const hashedPassword = md5(password);
    db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(name, email, hashedPassword);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Database error');
  }
});


// Add a new user API
app.post('/api/add', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({
      error: 'Name, email, and password are required',
    });
  }
  try {
    const hashedPassword = md5(password);
    const result = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(name, email, hashedPassword);
    return res.status(201).json({
      message: 'User created successfully',
      user: {
        id: result.lastInsertRowid,
        name,
        email,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error' });
  }
});


// Delete a user
app.post('/delete/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).send('Invalid ID');
  }
  try {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
});

app.use((req, res, next) => {
  res.status(404).send("<h1>404: Sorry, that resource doesn't exist!</h1>")
})

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
