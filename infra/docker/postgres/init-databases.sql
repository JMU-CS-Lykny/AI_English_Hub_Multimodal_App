-- Create per-service databases (database-per-service ownership)
CREATE DATABASE identity_db;
CREATE DATABASE classroom_db;
CREATE DATABASE content_db;
CREATE DATABASE assessment_db;
CREATE DATABASE progress_db;
CREATE DATABASE notification_db;
CREATE DATABASE media_db;
CREATE DATABASE rag_meta_db;

GRANT ALL PRIVILEGES ON DATABASE identity_db TO englishhub;
GRANT ALL PRIVILEGES ON DATABASE classroom_db TO englishhub;
GRANT ALL PRIVILEGES ON DATABASE content_db TO englishhub;
GRANT ALL PRIVILEGES ON DATABASE assessment_db TO englishhub;
GRANT ALL PRIVILEGES ON DATABASE progress_db TO englishhub;
GRANT ALL PRIVILEGES ON DATABASE notification_db TO englishhub;
GRANT ALL PRIVILEGES ON DATABASE media_db TO englishhub;
GRANT ALL PRIVILEGES ON DATABASE rag_meta_db TO englishhub;
