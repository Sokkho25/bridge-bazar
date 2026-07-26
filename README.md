# Bridge Bazar backend

The visual frontend remains in `index.html`. This Express server serves it and persists its marketplace data in MongoDB.

## Start it

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env`.
3. Set `MONGODB_URI` to your local MongoDB or MongoDB Atlas connection string.
4. Start the site: `npm start`
5. Open `http://localhost:3000` (do not open `index.html` directly).

On the first server-backed load, the app moves any existing browser data into MongoDB. Later changes are saved automatically. The page layout and styling are unchanged.

## API

- `GET /api/health` checks the server and database connection.
- `GET /api/state` returns persisted marketplace data.
- `PUT /api/state/:key` updates one approved collection.

## Put it online with GitHub and Render

GitHub stores the source code. Render runs the Node.js server and provides the public URL. The included `render.yaml` configures this automatically.

1. Create an empty GitHub repository (do not add a README, `.gitignore`, or license there).
2. Push this project to that repository. Never upload `.env`; it is already ignored.
3. In [Render](https://render.com/), choose **New** → **Blueprint**, then connect the GitHub repository.
4. When Render asks for `MONGODB_URI`, paste the MongoDB Atlas connection string there. Do not add it to GitHub.
5. Deploy. Render will give you an `https://...onrender.com` URL. Opening that link runs the complete frontend and backend.

Before deploying, add Render's outbound IP range to MongoDB Atlas **Network Access**, or temporarily allow `0.0.0.0/0` for testing. Restrict the rule before production use.
