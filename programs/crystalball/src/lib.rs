use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;

declare_id!("FfGmPDwyMvLU66asNGZ5GWYn9pAKhAA8iHYwhHdGdoph");

#[program]
pub mod crystalball {
    use super::*;

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        protocol_fee: u8,
        fee_receiver: Pubkey,
        is_paused: bool,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        msg!("set admin {}", config.admin.key());
        if config.admin == Pubkey::default() {
            config.admin = ctx.accounts.admin.key();
            msg!("set admin")
        } 
        // check owner
        if config.admin != ctx.accounts.admin.key() {
            return Err(ErrorCode::InvalidOwner.into());
        }
        config.protocol_fee = protocol_fee;
        config.fee_receiver = fee_receiver;
        config.is_paused = is_paused;

        emit!(ConfigUpdated {
            admin: config.admin,
            protocol_fee,
            fee_receiver,
            is_paused
        });

        Ok(())
    }

    pub fn create(
        ctx: Context<CreatePrediction>,
        seed: u64,
        title: String,
        description: String,
        image_url: String,
        ended_time: i64,
        reveal_deadline: i64,
        creator_fee: u8,
        options: Vec<OptionData>,
    ) -> Result<()> {
        if ctx.accounts.config.is_paused {
            return Err(ErrorCode::ProgramIsPaused.into());
        }
        if title.len() > 50 {
            return Err(ErrorCode::TitleTooLong.into());
        }
        if description.len() > 500 {
            return Err(ErrorCode::DescriptionTooLong.into());
        }
        if options.len() > 10 {
            return Err(ErrorCode::TooManyOptions.into());
        }
        for option in &options {
            if option.label.len() > 10 {
                return Err(ErrorCode::OptionLabelTooLong.into());
            }
        }

        let current_time = Clock::get()?.unix_timestamp;
        if ended_time <= current_time + 2 {
            return Err(ErrorCode::EndedTimeInvalid.into());
        }
        if reveal_deadline <= ended_time {
            return Err(ErrorCode::RevealDeadlineInvalid.into());
        }

        let prediction = &mut ctx.accounts.prediction;
        prediction.created_time = current_time;
        prediction.ended_time = ended_time;
        prediction.reveal_deadline = reveal_deadline;
        prediction.revealed_time = 0;
        prediction.protocol_fee = ctx.accounts.config.protocol_fee;
        prediction.creator_fee = creator_fee;
        prediction.creator = *ctx.accounts.creator.key;
        prediction.title = title.clone();
        prediction.description = description.clone();
        prediction.image_url = image_url.clone();
        prediction.participants = 0;
        prediction.total_pool = 0;
        prediction.seed = seed;
        prediction.options = options.clone();

        emit!(PredictionCreated {
            pred_key: prediction.key(),
            creator: ctx.accounts.creator.key(),
            title,
            description,
            image_url,
            created_time: prediction.created_time,
            ended_time,
            reveal_deadline,
            creator_fee,
            protocol_fee: prediction.protocol_fee,
            options,
        });

        Ok(())
    }

    pub fn predict(ctx: Context<UserPrediction>, option_index: u8, amount: u64) -> Result<()> {
        if Clock::get()?.unix_timestamp > ctx.accounts.prediction.ended_time {
            return Err(ErrorCode::PredictionClosed.into());
        }

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.user.key(),
            &ctx.accounts.prediction.key(),
            amount,
        );
        invoke(
            &ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.prediction.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let prediction = &mut ctx.accounts.prediction;
        let user_option = &mut ctx.accounts.user_option;

        if user_option.amount == 0 {
            prediction.participants += 1;
        }
        prediction.total_pool += amount;

        user_option.user = *ctx.accounts.user.key;
        user_option.option_index = option_index;
        user_option.amount += amount;

        let option = prediction.options.get_mut(option_index as usize)
            .ok_or(ErrorCode::InvalidOption)?;
        option.amount += amount;

        emit!(UserPredicted {
            pred_key: prediction.key(),
            pred_total_pool: prediction.total_pool,
            pred_participants: prediction.participants,
            up_key: user_option.key(),
            user: *ctx.accounts.user.key,
            option_index,
            amount,
        });

        Ok(())
    }

    pub fn reveal(ctx: Context<Reveal>, result_index: u8) -> Result<()> {
        let prediction = &mut ctx.accounts.prediction;
        let creator = &mut ctx.accounts.creator;
        let fee_receiver = &mut ctx.accounts.fee_receiver;
        let config = &ctx.accounts.config;
        
        if Clock::get()?.unix_timestamp < prediction.ended_time {
            return Err(ErrorCode::PredictionStillOpen.into());
        }

        if Clock::get()?.unix_timestamp > prediction.reveal_deadline {
            return Err(ErrorCode::RevealDeadlinePassed.into());
        }

        if prediction.revealed_time != 0 {
            return Err(ErrorCode::PredictionEnded.into());
        }

        if *creator.key != prediction.creator {
            return Err(ErrorCode::InvalidCreator.into());
        }

        if *fee_receiver.key != config.fee_receiver {
            return Err(ErrorCode::InvalidFeeReceiver.into());
        }

         // Check if result_index is valid
        if result_index as usize >= prediction.options.len() {
            return Err(ErrorCode::InvalidOption.into());
        }

        prediction.result_index = result_index;
        prediction.revealed_time = Clock::get()?.unix_timestamp;


        let creator_amount = prediction.total_pool * (prediction.creator_fee as u64) / 100;
        let protocol_amount = prediction.total_pool * (prediction.protocol_fee as u64) / 100;

        let balance = **prediction.to_account_info().lamports.borrow();
        if balance < creator_amount + protocol_amount {
            return Err(ErrorCode::InsufficientFunds.into());
        }
       
        // Transfer the fees
        **prediction.to_account_info().try_borrow_mut_lamports()? -= creator_amount + protocol_amount;
        **creator.to_account_info().try_borrow_mut_lamports()? += creator_amount;
        **fee_receiver.to_account_info().try_borrow_mut_lamports()? += protocol_amount;

        emit!(PredictionRevealed {
            pred_key: prediction.key(),
            result_index,
            creator_amount,
            protocol_amount,
        });

        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let prediction = &ctx.accounts.prediction;
        let user = &ctx.accounts.user;
        let user_option = &mut ctx.accounts.user_option;

        if prediction.revealed_time == 0 {
            return Err(ErrorCode::ResultNotRevealed.into());
        }

        if user_option.option_index != prediction.result_index {
            return Err(ErrorCode::WrongOption.into());
        }

        if user_option.claimed {
            return Err(ErrorCode::AlreadyClaimed.into());
        }

        let winning_option = prediction.options.get(prediction.result_index as usize)
            .ok_or(ErrorCode::InvalidOption)?;

        let reward_pool = prediction.total_pool * (100 - prediction.creator_fee - prediction.protocol_fee) as u64 / 100;
        let user_reward = ((user_option.amount as u128) * (reward_pool as u128) / (winning_option.amount as u128)) as u64;

        user_option.claimed = true;

        // Transfer the amount to the creator
        **prediction.to_account_info().try_borrow_mut_lamports()? -= user_reward;
        **user.to_account_info().try_borrow_mut_lamports()? += user_reward;

        emit!(RewardClaimed {
            pred_key: prediction.key(),
            up_key: user_option.key(),
            user: *ctx.accounts.user.key,
            principal: user_option.amount,
            reward: user_reward,
        });

        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let prediction = &ctx.accounts.prediction;
        let user = &ctx.accounts.user;
        let user_option = &mut ctx.accounts.user_option;
    
        if Clock::get()?.unix_timestamp <= prediction.reveal_deadline {
            return Err(ErrorCode::PredictionNotExpired.into());
        }
    
        if prediction.revealed_time != 0 {
            return Err(ErrorCode::PredictionAlreadyRevealed.into());
        }
    
        if user_option.claimed {
            return Err(ErrorCode::AlreadyClaimed.into());
        }
    
        let user_amount = user_option.amount;
        user_option.claimed = true;
    
        // Transfer the amount back to the user
        **prediction.to_account_info().try_borrow_mut_lamports()? -= user_amount;
        **user.to_account_info().try_borrow_mut_lamports()? += user_amount;
    
        emit!(UserWithdrawn {
            pred_key: prediction.key(),
            up_key: user_option.key(),
            user: *ctx.accounts.user.key,
            amount: user_amount,
        });
    
        Ok(())
    }
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(init_if_needed, seeds = [b"config"], bump, payer = admin, space = 8 + 66)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct CreatePrediction<'info> {
    // #[account(init, payer = creator, space = 8 + Prediction::INIT_SPACE)]
    #[account(init, seeds = [b"prediction", seed.to_le_bytes().as_ref()], bump, payer = creator, space = 8 + Prediction::INIT_SPACE)]
    pub prediction: Account<'info, Prediction>,
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(option_index: u8)]
pub struct UserPrediction<'info> {
    #[account(mut, seeds = [b"prediction", prediction.seed.to_le_bytes().as_ref()], bump)]
    pub prediction: Account<'info, Prediction>,
    #[account(init_if_needed, seeds = [b"user-option", user.key().as_ref(), prediction.key().as_ref(), &[option_index]], bump, payer = user, space = 8 + UserOption::INIT_SPACE)]
    pub user_option: Account<'info, UserOption>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Reveal<'info> {
    #[account(mut, seeds = [b"prediction", prediction.seed.to_le_bytes().as_ref()], bump)]
    pub prediction: Account<'info, Prediction>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>, 
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: This account will receive fees and its balance will be modified.
    #[account(mut)]
    pub fee_receiver: AccountInfo<'info>, 
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [b"prediction", prediction.seed.to_le_bytes().as_ref()], bump)]
    pub prediction: Account<'info, Prediction>,
    #[account(mut, seeds = [b"user-option", user.key().as_ref(), prediction.key().as_ref(), &[user_option.option_index]], bump)]
    pub user_option: Account<'info, UserOption>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"prediction", prediction.seed.to_le_bytes().as_ref()], bump)]
    pub prediction: Account<'info, Prediction>,
    #[account(mut, seeds = [b"user-option", user.key().as_ref(), prediction.key().as_ref(), &[user_option.option_index]], bump)]
    pub user_option: Account<'info, UserOption>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub protocol_fee: u8,
    pub fee_receiver: Pubkey,
    pub is_paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Prediction {
    #[max_len(50)]
    pub title: String,
    #[max_len(500)]
    pub description: String,
    #[max_len(66)]
    pub image_url: String,
    pub created_time: i64,
    pub ended_time: i64,
    pub reveal_deadline: i64,
    pub revealed_time: i64,
    pub protocol_fee: u8,
    pub creator_fee: u8,
    pub creator: Pubkey,
    pub result_index: u8,
    pub participants: u32,
    pub total_pool: u64,
    pub seed: u64,
    #[max_len(10)]
    pub options: Vec<OptionData>,
}

#[account]
#[derive(InitSpace)]
pub struct UserOption {
    pub user: Pubkey,
    pub option_index: u8,
    pub amount: u64,
    pub claimed: bool,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
#[derive(InitSpace)]
pub struct OptionData {
    #[max_len(10)]
    pub label: String,
    pub amount: u64,
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub protocol_fee: u8,
    pub fee_receiver: Pubkey,
    pub is_paused: bool,
}

#[event]
pub struct PredictionCreated {
    pub pred_key: Pubkey,
    pub creator: Pubkey,
    pub title: String,
    pub description: String,
    pub image_url: String,
    pub created_time: i64,
    pub ended_time: i64,
    pub reveal_deadline: i64,
    pub creator_fee: u8,
    pub protocol_fee: u8,
    pub options: Vec<OptionData>,
}

#[event]
pub struct UserPredicted {
    pub pred_key: Pubkey,
    pub pred_total_pool: u64,
    pub pred_participants: u32,
    pub up_key: Pubkey,
    pub user: Pubkey,
    pub option_index: u8,
    pub amount: u64,
}

#[event]
pub struct PredictionRevealed {
    pub pred_key: Pubkey,
    pub result_index: u8,
    pub creator_amount: u64,
    pub protocol_amount: u64,
}

#[event]
pub struct RewardClaimed {
    pub pred_key: Pubkey,
    pub up_key: Pubkey,
    pub user: Pubkey,
    pub principal: u64,
    pub reward: u64,
}

#[event]
pub struct UserWithdrawn {
    pub pred_key: Pubkey,
    pub up_key: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Program is paused")]
    ProgramIsPaused,
    #[msg("Prediction has closed")]
    PredictionClosed,
    #[msg("Prediction is still open")]
    PredictionStillOpen,
    #[msg("Prediction has ended")]
    PredictionEnded,
    #[msg("Prediction not expired")]
    PredictionNotExpired,
    #[msg("Prediction already revealed")]
    PredictionAlreadyRevealed,
    #[msg("Ended time must be greater than created time")]
    EndedTimeInvalid,
    #[msg("Reveal deadline must be greater than ended time")]
    RevealDeadlineInvalid,
    #[msg("Result not revealed")]
    ResultNotRevealed,
    #[msg("Reveal deadline has passed")]
    RevealDeadlinePassed, 
    #[msg("Invalid option")]
    InvalidOption,
    #[msg("Wrong option")]
    WrongOption,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Insufficient funds")]
    InsufficientFunds,
    #[msg("Title is too long")]
    TitleTooLong,
    #[msg("Description is too long")]
    DescriptionTooLong,
    #[msg("Option label is too long")]
    OptionLabelTooLong,
    #[msg("Too many options")]
    TooManyOptions,
    #[msg("Invalid owner")]
    InvalidOwner,
    #[msg("Invalid creator")]
    InvalidCreator,
    #[msg("Invalid fee receiver")]
    InvalidFeeReceiver,
}
