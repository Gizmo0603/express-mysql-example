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
      account_type TEXT NOT NULL DEFAULT 'parent',
      keystring TEXT UNIQUE,
      FOREIGN KEY (parent_id) REFERENCES users(id) ON DELETE CASCADE
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
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `); //New table for Transactions
    db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER,
      to_user_id INTEGER,
      amount INTEGER NOT null,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

  db.exec('PRAGMA foreign_keys = ON');//enables cascading between parent/child

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
    t.reason,
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

    const key = randomBytes(4).toString('hex'); //API key, 8 in length for hex
    const result = db.prepare( //New parent user in db.
      `INSERT INTO users (name, 
      email, 
      password, 
      parent_id, 
      account_type,
      keystring)
      VALUES (?, ?, ?, ?, ?, ?)
      `).run(username, email, md5(password), null, 'parent', key); //Added Parent_id/Account_type to give parents unique modifier.

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

    const key = randomBytes(4).toString('hex'); //API key, 8 in length for hex
    const result = db.prepare(`
      INSERT INTO users (
      name,
      email,
      password,
      parent_id,
      keystring,
      account_type
      ) VALUES (?, ?, ?, ?, ?, ?)`).run(username, email, md5(password), parentId, key,'child'); //Inserts into the DB + Creates child

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

app.get('/api', (req, res) => {
  const key = req.query.key; //requires them to add api?key=(key) to it. 

  if (!key) { //If no key, it takes them here.
    return res.status(401).json({
      error: 'API Key Required'
    });
  }

  try {
    const user = db.prepare(`
      SELECT
        id,
        name,
        email,
        parent_id,
        account_type
      FROM users
      WHERE keystring = ?
    `).get(key); //finds user via key, if its equal to that input.

    if (!user) {
      return res.status(403).json({
        error: 'Invalid API key' //If it finds no one with that key, fails them (Tells them invalid)
      });
    }

    const cards = db.prepare(`
      SELECT
        type,
        number,
        expiry,
        money
      FROM cards
      WHERE user_id = ?
    `).all(user.id); // Selects the info from cards to display (I can change this to whatever I want by removing/adding bits)

    const transactions = db.prepare(`
      SELECT
        amount,
        reason,
        created_at,
        from_user_id,
        to_user_id
      FROM transactions
      WHERE from_user_id = ?
         OR to_user_id = ?
      ORDER BY created_at DESC
    `).all(user.id, user.id); // Selects the info from transactions to display (I can change this to whatever I want by removing/adding bits)

    let children = []; //This section shows child accounts (If parent account is looking at their API)
    if (user.account_type === 'parent') {
      children = db.prepare(`
        SELECT
          id,
          name,
          email,
          account_type
        FROM users
        WHERE parent_id = ?
      `).all(user.id);
    }

    return res.json({
      user,
      cards,
      children,
      transactions
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: 'Database error'
    });
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

app.post('/transfer', requireLogin, (req, res) => { 

  const fromUserId = req.session.userId; //Pulls from logged in user id (Sender) 
  const { toEmail, amount, reason } = req.body; //toemail (who sending it to), amount (how much) reason (Optional Note) 
  const amountPence = Math.round(parseFloat(amount) * 100); 

  if (isNaN(amountPence) || amountPence <= 0) { //Prevents Letters, 0 transfer, negative transfers, letters. 
    return res.status(400).send("Invalid amount"); 
  } 

  try { 
    const recipient = db.prepare(` 
      SELECT * FROM users WHERE email = ? 
    `).get(toEmail); //Looks user up by email, returns row. 

    if (!recipient) { 
      return res.status(400).send("Recipient not found"); 
    } //Stops process if user doesn't exist. 

 

    if (recipient.id === fromUserId) { 
      return res.status(400).send("Cannot send to yourself"); 
    } //stops transfering to self. 

    const senderCard = db.prepare( 
      'SELECT * FROM cards WHERE user_id = ?' 
    ).get(fromUserId); //gets senders card details 

    if (!senderCard || senderCard.money < amountPence) { 
      return res.status(400).send("Not enough funds"); //stops overdrawing and missing cards. 
    } 

    db.exec('BEGIN'); //begins the transaction. If one part succeeds, undoes it all. 

    db.prepare( 
      'UPDATE cards SET money = money - ? WHERE user_id = ?' 
    ).run(amountPence, fromUserId); //takes from sender 

    db.prepare( 
      'UPDATE cards SET money = money + ? WHERE user_id = ?' 
    ).run(amountPence, recipient.id); //Adds to receiver 

    db.prepare(` 
      INSERT INTO transactions (from_user_id, to_user_id, amount, reason) 
      VALUES (?, ?, ?, ?) 
    `).run(fromUserId, recipient.id, amountPence, reason || null); //Logs to transactions db 
    db.exec('COMMIT'); //saves it all. 

    res.redirect('/main'); //redirects. 

  } catch (err) { 
    db.exec('ROLLBACK'); 
    console.error(err); 
    res.status(500).send("Transfer failed"); //If it fails, rollback undoes all changes. 
  } 

}); 

 

app.get('/transfer', requireLogin, (req, res) => {
  res.render('transfer', { error: null });
});

app.use((req, res, next) => {
  res.status(404).send("<h1>404: Sorry, that resource doesn't exist!</h1>")
})

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
