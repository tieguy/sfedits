#!/usr/bin/env node

const fs = require('fs')
const { wmFetchJson } = require('../lib/mw-api')

function getConfig() {
  const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'))
  return config
}

async function getWikipediaCategories(pageTitle) {
  const encodedTitle = encodeURIComponent(pageTitle)
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=categories&titles=${encodedTitle}&cllimit=max`

  try {
    const response = await wmFetchJson(url, { component: 'find-categories', timeoutMs: 30000 })

    const pages = response.query.pages
    const pageId = Object.keys(pages)[0]

    if (pageId === '-1') {
      console.log(`  ❌ Page "${pageTitle}" not found`)
      return []
    }

    const categories = pages[pageId].categories || []
    const categoryNames = categories.map(cat => cat.title.replace('Category:', ''))
    return categoryNames
  } catch (error) {
    throw error
  }
}

async function main() {
  const config = getConfig()
  
  console.log('Finding categories for all English Wikipedia articles in config...\n')
  
  for (const account of config.accounts) {
    if (account.watchlist && account.watchlist['English Wikipedia']) {
      const articles = Object.keys(account.watchlist['English Wikipedia'])
      
      console.log(`Found ${articles.length} English Wikipedia articles to analyze:\n`)
      
      for (const article of articles) {
        console.log(`📄 ${article}`)
        try {
          const categories = await getWikipediaCategories(article)
          if (categories.length > 0) {
            categories.forEach(cat => console.log(`  - ${cat}`))
          } else {
            console.log('  - No categories found')
          }
          console.log() // blank line
          
          // Rate limiting - be nice to Wikipedia's API
          await new Promise(resolve => setTimeout(resolve, 100))
          
        } catch (error) {
          console.log(`  ❌ Error fetching categories: ${error.message}`)
          console.log()
        }
      }
    }
  }
}

if (require.main === module) {
  main().catch(console.error)
}