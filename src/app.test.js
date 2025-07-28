import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import App from './App'

// Replace all jest.fn() with vi.fn()
// Replace all jest.mock() with vi.mock()
// Replace all jest.clearAllMocks() with vi.clearAllMocks()

describe('Friend Suggestions Component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render without crashing', () => {
    render(<App />)
    expect(screen.getByText('🌐 Social Connect')).toBeInTheDocument()
  })

  it('should display suggestions when available', () => {
    render(<App debug={true} />)
    expect(screen.getByText('People you may know')).toBeInTheDocument()
    const connectButtons = screen.getAllByText('CONNECT')
    expect(connectButtons.length).toBeGreaterThan(0)
  })

  // Add more tests here...
})
