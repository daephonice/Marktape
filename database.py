import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = (
    os.getenv("DATABASE_URL")
    or os.getenv("DATABASE_PRIVATE_URL")
    or os.getenv("DATABASE_PUBLIC_URL")
    or ""
).strip().strip('"').strip("'")

if not DATABASE_URL:
    candidates = sorted(
        k for k in os.environ
        if "DATABASE" in k.upper() or "POSTGRES" in k.upper() or k.upper().startswith("PG")
    )
    raise RuntimeError(
        "DATABASE_URL is empty or unset on this service. "
        f"DB-related env var NAMES found here: {candidates or 'NONE'}. "
        "Fix on Railway: open the web service (not the Postgres service) -> "
        "Variables -> New Variable -> Reference -> pick the Postgres service's "
        "DATABASE_URL. Then redeploy."
    )

# Railway/Heroku-style URLs start with postgres:// ; SQLAlchemy needs postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {"connect_timeout": 5}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
