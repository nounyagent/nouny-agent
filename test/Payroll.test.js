const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const U = (n) => ethers.parseUnits(String(n), 6); // USDG, 6 decimals
const DAY = 86400;
const WEEK = 7 * DAY;

describe('Payroll', function () {
  if (process.env.FORK) return;

  let owner, alice, bob, keeper, stranger, usdg, factory, pr;

  beforeEach(async () => {
    [owner, alice, bob, keeper, stranger] = await ethers.getSigners();
    usdg = await ethers.deployContract('MockToken', ['Global Dollar', 'USDG', 6]);
    factory = await ethers.deployContract('PayrollFactory', [await usdg.getAddress()]);
    await factory.connect(owner).createPayroll();
    pr = await ethers.getContractAt('PayrollVault', await factory.payrollOf(owner.address));
    await usdg.mint(pr, U(1000));
  });

  it('factory: one payroll per wallet, owner and token set, enumerable', async () => {
    expect(await pr.owner()).to.equal(owner.address);
    expect(await pr.token()).to.equal(await usdg.getAddress());
    await expect(factory.connect(owner).createPayroll()).to.be.revertedWithCustomError(factory, 'PayrollExists');
    await factory.connect(alice).createPayroll();
    expect(await factory.payrollCount()).to.equal(2);
    expect((await factory.payrolls(0, 10)).length).to.equal(2);
    expect((await factory.payrolls(1, 10))[0]).to.equal(await factory.payrollOf(alice.address));
    expect((await factory.payrolls(5, 10)).length).to.equal(0);
  });

  it('only the owner manages recipients, pauses and withdraws', async () => {
    await expect(pr.connect(stranger).addRecipient(stranger.address, U(1), WEEK, 0)).to.be.revertedWithCustomError(pr, 'NotOwner');
    await pr.addRecipient(alice.address, U(100), WEEK, 0);
    await expect(pr.connect(stranger).updateRecipient(0, U(999), WEEK, 0)).to.be.revertedWithCustomError(pr, 'NotOwner');
    await expect(pr.connect(stranger).removeRecipient(0)).to.be.revertedWithCustomError(pr, 'NotOwner');
    await expect(pr.connect(stranger).setPaused(true)).to.be.revertedWithCustomError(pr, 'NotOwner');
    await expect(pr.connect(stranger).withdraw(1)).to.be.revertedWithCustomError(pr, 'NotOwner');
    await expect(pr.connect(alice).withdraw(1)).to.be.revertedWithCustomError(pr, 'NotOwner');
  });

  it('validates inputs', async () => {
    await expect(pr.addRecipient(ethers.ZeroAddress, U(1), WEEK, 0)).to.be.revertedWithCustomError(pr, 'ZeroAddress');
    await expect(pr.addRecipient(await pr.getAddress(), U(1), WEEK, 0)).to.be.revertedWithCustomError(pr, 'ZeroAddress');
    await expect(pr.addRecipient(alice.address, 0, WEEK, 0)).to.be.revertedWithCustomError(pr, 'ZeroAmount');
    await expect(pr.addRecipient(alice.address, U(1), DAY - 1, 0)).to.be.revertedWithCustomError(pr, 'BadInterval');
    await expect(pr.addRecipient(alice.address, U(1), 367 * DAY, 0)).to.be.revertedWithCustomError(pr, 'BadInterval');
    const now = await time.latest();
    await expect(pr.addRecipient(alice.address, U(1), WEEK, now - 100)).to.be.revertedWithCustomError(pr, 'BadStart');
    await expect(pr.addRecipient(alice.address, U(1), WEEK, now + 400 * DAY)).to.be.revertedWithCustomError(pr, 'BadStart');
  });

  it('pays once per interval to the registered address only, callable by anyone', async () => {
    await pr.addRecipient(alice.address, U(100), WEEK, 0);
    await expect(pr.connect(keeper).pay(0)).to.emit(pr, 'Paid');
    expect(await usdg.balanceOf(alice.address)).to.equal(U(100));
    await expect(pr.connect(keeper).pay(0)).to.be.revertedWithCustomError(pr, 'NotDue');
    await expect(pr.connect(alice).pay(0)).to.be.revertedWithCustomError(pr, 'NotDue');
    await time.increase(WEEK - 10);
    await expect(pr.connect(stranger).pay(0)).to.be.revertedWithCustomError(pr, 'NotDue');
    await time.increase(10);
    await pr.connect(stranger).pay(0);
    expect(await usdg.balanceOf(alice.address)).to.equal(U(200));
    expect(await usdg.balanceOf(stranger.address)).to.equal(0);
    expect(await usdg.balanceOf(keeper.address)).to.equal(0);
  });

  it('future start date is respected', async () => {
    const start = (await time.latest()) + 3 * DAY;
    await pr.addRecipient(alice.address, U(50), WEEK, start);
    await expect(pr.pay(0)).to.be.revertedWithCustomError(pr, 'NotDue');
    await time.increaseTo(start);
    await pr.pay(0);
    expect((await pr.getRecipient(0)).nextPayAt).to.equal(BigInt(start + WEEK));
  });

  it('catches up missed periods one at a time, never more than owed', async () => {
    await pr.addRecipient(alice.address, U(10), WEEK, 0);
    await time.increase(3 * WEEK + 5); // 4 periods due (now, +1w, +2w, +3w)
    for (let i = 0; i < 4; i++) await pr.connect(keeper).payAllDue();
    expect(await usdg.balanceOf(alice.address)).to.equal(U(40));
    await pr.connect(keeper).payAllDue(); // nothing more due
    expect(await usdg.balanceOf(alice.address)).to.equal(U(40));
  });

  it('payAllDue pays affordable recipients and skips the rest', async () => {
    await pr.addRecipient(alice.address, U(600), WEEK, 0);
    await pr.addRecipient(bob.address, U(600), WEEK, 0); // only 1000 in vault
    await pr.addRecipient(keeper.address, U(300), WEEK, 0);
    await expect(pr.connect(stranger).payAllDue()).to.emit(pr, 'Skipped');
    expect(await usdg.balanceOf(alice.address)).to.equal(U(600));
    expect(await usdg.balanceOf(bob.address)).to.equal(0);
    expect(await usdg.balanceOf(keeper.address)).to.equal(U(300));
    expect((await pr.getRecipient(1)).nextPayAt).to.be.lte(await time.latest()); // bob stays due
    await usdg.mint(pr, U(600));
    await pr.payAllDue();
    expect(await usdg.balanceOf(bob.address)).to.equal(U(600));
  });

  it('pay reverts when balance is too low', async () => {
    await pr.addRecipient(alice.address, U(5000), WEEK, 0);
    await expect(pr.pay(0)).to.be.revertedWithCustomError(pr, 'InsufficientBalance');
  });

  it('pause stops payments but not withdrawals', async () => {
    await pr.addRecipient(alice.address, U(100), WEEK, 0);
    await pr.setPaused(true);
    await expect(pr.connect(keeper).pay(0)).to.be.revertedWithCustomError(pr, 'IsPaused');
    await expect(pr.connect(keeper).payAllDue()).to.be.revertedWithCustomError(pr, 'IsPaused');
    expect((await pr.dueNow()).count).to.equal(0);
    await pr.withdraw(U(400));
    expect(await usdg.balanceOf(owner.address)).to.equal(U(400));
    await pr.setPaused(false);
    await pr.connect(keeper).pay(0);
    expect(await usdg.balanceOf(alice.address)).to.equal(U(100));
  });

  it('remove and update recipients', async () => {
    await pr.addRecipient(alice.address, U(100), WEEK, 0);
    await pr.addRecipient(bob.address, U(100), WEEK, 0);
    expect(await pr.activeCount()).to.equal(2);
    await pr.removeRecipient(0);
    expect(await pr.activeCount()).to.equal(1);
    await expect(pr.pay(0)).to.be.revertedWithCustomError(pr, 'UnknownRecipient');
    await expect(pr.removeRecipient(0)).to.be.revertedWithCustomError(pr, 'UnknownRecipient');
    const d = await pr.dueNow();
    expect(d.count).to.equal(1);
    expect(d.amount).to.equal(U(100));
    const next = (await time.latest()) + 2 * DAY;
    await pr.updateRecipient(1, U(25), 30 * DAY, next);
    await expect(pr.pay(1)).to.be.revertedWithCustomError(pr, 'NotDue');
    await time.increaseTo(next);
    await pr.pay(1);
    expect(await usdg.balanceOf(bob.address)).to.equal(U(25));
    expect((await pr.getRecipients()).length).to.equal(2);
  });

  it('withdraw all and rescue other tokens', async () => {
    await pr.withdraw(ethers.MaxUint256);
    expect(await usdg.balanceOf(owner.address)).to.equal(U(1000));
    await expect(pr.withdraw(1)).to.be.revertedWithCustomError(pr, 'InsufficientBalance');
    const other = await ethers.deployContract('MockToken', ['Other', 'OTH', 18]);
    await other.mint(pr, 5n);
    await pr.rescue(await other.getAddress(), 5n);
    expect(await other.balanceOf(owner.address)).to.equal(5n);
    await expect(pr.rescue(await usdg.getAddress(), 1)).to.be.revertedWithCustomError(pr, 'ZeroAddress');
  });

  it('caps recipients at 100', async () => {
    for (let i = 0; i < 100; i++) await pr.addRecipient(alice.address, 1, WEEK, 0);
    await expect(pr.addRecipient(alice.address, 1, WEEK, 0)).to.be.revertedWithCustomError(pr, 'TooManyRecipients');
    const tx = await pr.connect(keeper).payAllDue({ gasLimit: 15_000_000 });
    const rc = await tx.wait();
    expect(await usdg.balanceOf(alice.address)).to.equal(100n);
    expect(rc.gasUsed).to.be.lt(10_000_000n);
  });

  it('fuzz: total paid never exceeds what was owed and never leaves to strangers', async () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const people = [alice, bob, keeper];
    const amounts = [U(7), U(13), U(29)];
    const intervals = [DAY, 3 * DAY, WEEK];
    for (let i = 0; i < 3; i++) await pr.addRecipient(people[i].address, amounts[i], intervals[i], 0);
    const start = await time.latest();
    await usdg.mint(pr, U(100_000));
    for (let step = 0; step < 120; step++) {
      await time.increase(Math.floor(rnd() * 2 * DAY));
      if (rnd() < 0.5) await pr.connect(stranger).payAllDue();
      else await pr.connect(stranger).pay(Math.floor(rnd() * 3)).catch(() => {});
    }
    const elapsed = (await time.latest()) - start;
    for (let i = 0; i < 3; i++) {
      const maxPeriods = BigInt(Math.floor(elapsed / intervals[i]) + 1);
      expect(await usdg.balanceOf(people[i].address)).to.be.lte(amounts[i] * maxPeriods);
    }
    expect(await usdg.balanceOf(stranger.address)).to.equal(0);
  });
});
