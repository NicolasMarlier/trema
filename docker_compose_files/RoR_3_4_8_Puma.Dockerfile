# Use official Ruby image
FROM ruby:3.4.8

# Install system dependencies
RUN apt-get update -qq && apt-get install -y \
  build-essential \
  libpq-dev \
  nodejs \
  npm \
  git

# Set working directory
WORKDIR /app

# Install bundler
RUN gem install bundler

# Copy Gemfiles first (better Docker caching)
COPY Gemfile Gemfile.lock ./

# Install gems
RUN bundle install

# Copy the rest of the application
COPY . .

# Start Rails server with Puma
CMD ["bundle", "exec", "puma", "-C", "config/puma.rb"]