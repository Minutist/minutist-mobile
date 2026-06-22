import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

describe('App', () => {
  it('renders the product name', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Minutist' })).toBeInTheDocument();
  });

  it('renders both tabs', () => {
    render(<App />);
    expect(screen.getByRole('tab', { name: 'Capture' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Meetings' })).toBeInTheDocument();
  });

  it('shows the Capture view by default', () => {
    render(<App />);
    expect(screen.getByLabelText('Capture view')).toBeInTheDocument();
    expect(screen.queryByLabelText('Meetings view')).not.toBeInTheDocument();
  });

  it('switches to the Meetings view when the Meetings tab is clicked', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: 'Meetings' }));
    expect(screen.getByLabelText('Meetings view')).toBeInTheDocument();
    expect(screen.queryByLabelText('Capture view')).not.toBeInTheDocument();
  });

  it('switches back to the Capture view when the Capture tab is clicked', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: 'Meetings' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Capture' }));
    expect(screen.getByLabelText('Capture view')).toBeInTheDocument();
    expect(screen.queryByLabelText('Meetings view')).not.toBeInTheDocument();
  });
});
