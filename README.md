# 🟦 Shikaka

Minimalist, single-user implementation of the **Shikaku** (Rectangles) puzzle game.

Shikaku is a logic puzzle where you divide a grid into rectangular and square pieces such that each piece contains exactly one number, and that number represents the area of the rectangle.

## ✨ Features

- **Responsive Design**: Play comfortably on desktop or mobile.
- **Progress Persistence**: Your game state is saved automatically in a PostgreSQL database.
- **Secure Access**: Simple password-based authentication for private instances.
- **Minimalist Tech Stack**: Built with Vanilla JS and Node.js for maximum performance and zero bloat.

## 🛠 Tech Stack

- **Backend**: Node.js (Native modules + `pg`)
- **Database**: PostgreSQL
- **Frontend**: HTML5, CSS3, Vanilla JavaScript

## 🚀 Getting Started

### Prerequisites

- Node.js (v18 or higher)
- PostgreSQL

### Installation

1. **Clone the repository:**
   ```bash
   git clone git@github.com:Isnob/shikaka.git
   cd shikaka
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Database setup:**
   Create a database named `shikaka`:
   ```bash
   createdb shikaka
   ```

4. **Configuration:**
   Copy the example environment file and fill in your details:
   ```bash
   cp .env.example .env
   ```

5. **Start the application:**
   ```bash
   npm start
   ```
   Open `http://localhost:3000` in your browser.

## ⚙️ Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Port to run the server on | `3000` |
| `SHIKAKU_PASSWORD` | Access password for the game | `change-me` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://localhost:5432/shikaka` |
| `SESSION_SECRET` | Secret key for session hashing | (randomly generated) |

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
